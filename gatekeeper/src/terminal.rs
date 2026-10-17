//! The terminal connection. The browser asks to turn its HTTP request into a WebSocket (a
//! two-way stream). The gatekeeper sends ttyd a clean request with only the headers ttyd needs,
//! waits for ttyd to agree, gives the browser ttyd's answer, then joins the two streams.

use std::path::Path;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::time::timeout;

use crate::reply;

/// The only request headers ttyd receives.
const FORWARDED_HEADERS: [&str; 8] = [
    "host",
    "origin",
    "upgrade",
    "connection",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
];

/// The headers of ttyd's acceptance that the browser needs, including the proof
/// (`Sec-WebSocket-Accept`) without which the browser refuses the connection.
const ACCEPTANCE_HEADERS: [&str; 5] = [
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
];

/// ttyd's answer must arrive within this time and fit in this many bytes.
const TTYD_ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
const TTYD_ANSWER_LIMIT: usize = 16 * 1024;

/// Asks ttyd for a terminal session for this request. On success, answers the browser with 101
/// (Switching Protocols) and joins the two streams in the background, keeping `hold` alive until
/// the session ends (the caller uses it to count open connections).
pub async fn open(
    request: Request<Incoming>,
    ttyd_socket: &Path,
    hold: impl Send + 'static,
) -> Response<Full<Bytes>> {
    let Ok(mut ttyd) = UnixStream::connect(ttyd_socket).await else {
        eprintln!("Could not reach ttyd at {}", ttyd_socket.display());
        return reply(StatusCode::BAD_GATEWAY, "Terminal unavailable");
    };
    if ttyd
        .write_all(clean_request(&request).as_bytes())
        .await
        .is_err()
    {
        return reply(StatusCode::BAD_GATEWAY, "Terminal unavailable");
    }
    let Some((answer, early_output)) = read_answer(&mut ttyd).await else {
        return reply(StatusCode::BAD_GATEWAY, "Terminal unavailable");
    };
    let Some(acceptance) = acceptance_for_browser(&answer) else {
        return reply(StatusCode::BAD_GATEWAY, "Terminal refused");
    };

    tokio::spawn(async move {
        let _hold = hold;
        let Ok(upgraded) = hyper::upgrade::on(request).await else {
            return;
        };
        // hyper hands over anything the browser sent right after its request along with the stream.
        let mut browser = TokioIo::new(upgraded);
        // Anything ttyd sent right behind its acceptance has already been read; pass it on first.
        if browser.write_all(&early_output).await.is_err() {
            return;
        }
        // Copies both ways; when one side finishes sending, the other is told, and when either
        // fails, both are closed. So closing the page ends the ttyd session, and the reverse.
        let _ = tokio::io::copy_bidirectional(&mut browser, &mut ttyd).await;
    });
    acceptance
}

/// The request ttyd receives: a fixed request line and only the headers it needs.
fn clean_request(request: &Request<Incoming>) -> String {
    let mut text = String::from("GET /ws HTTP/1.1\r\n");
    for name in FORWARDED_HEADERS {
        if let Some(value) = request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
        {
            text.push_str(name);
            text.push_str(": ");
            text.push_str(value);
            text.push_str("\r\n");
        }
    }
    text.push_str("\r\n");
    text
}

/// Reads ttyd's answer up to the blank line after its headers. Returns the answer and any bytes
/// that arrived after it, or `None` if ttyd closed, was too slow, or sent too much.
async fn read_answer(ttyd: &mut UnixStream) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut received = Vec::new();
    let mut buffer = [0u8; 4096];
    let reading = async {
        loop {
            if let Some(end) = received.windows(4).position(|window| window == b"\r\n\r\n") {
                let early_output = received.split_off(end + 4);
                return Some((received, early_output));
            }
            if received.len() > TTYD_ANSWER_LIMIT {
                return None;
            }
            let read = ttyd.read(&mut buffer).await.ok().filter(|&read| read > 0)?;
            received.extend_from_slice(&buffer[..read]);
        }
    };
    timeout(TTYD_ANSWER_TIMEOUT, reading).await.ok().flatten()
}

/// The 101 answer for the browser, built from ttyd's, or `None` if ttyd did not accept.
fn acceptance_for_browser(answer: &[u8]) -> Option<Response<Full<Bytes>>> {
    let mut headers = [httparse::EMPTY_HEADER; 32];
    let mut parsed = httparse::Response::new(&mut headers);
    parsed.parse(answer).ok()?;
    if parsed.code? != StatusCode::SWITCHING_PROTOCOLS.as_u16() {
        return None;
    }
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    for header in parsed.headers.iter() {
        let name = header.name.to_ascii_lowercase();
        if ACCEPTANCE_HEADERS.contains(&name.as_str())
            && let Ok(value) = hyper::header::HeaderValue::from_bytes(header.value)
        {
            response.headers_mut().insert(
                hyper::header::HeaderName::from_bytes(name.as_bytes()).ok()?,
                value,
            );
        }
    }
    Some(response)
}
