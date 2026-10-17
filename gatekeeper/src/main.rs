//! Gatekeeper in front of ttyd. It is the only thing reachable over Tailscale: it drops every
//! device except the allowed ones, serves the terminal page, and forwards the terminal
//! connection to ttyd, which listens on a private socket file instead of the network.
//!
//! Tailscale accepts its own traffic before ufw sees it, so ufw cannot do this check.
//! Tailscale addresses cannot be forged: each one is tied to a device's encryption key.

mod config;
mod terminal;

use std::convert::Infallible;
use std::net::IpAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::header::{
    CONTENT_LENGTH, CONTENT_TYPE, HOST, HeaderValue, ORIGIN, TRANSFER_ENCODING, UPGRADE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

use config::Config;

/// systemd is told not to restart on this exit code, so a missing secret stops the service
/// instead of calling Bitwarden every few seconds forever.
const EXIT_CONFIG_ERROR: u8 = 78;

/// A connection that sends nothing for this long is closed, so idle browser connections give
/// their place back. An open terminal is not affected: it is a stream, not a request.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Only these files are served, read from the working directory; nothing else on disk is reachable.
const FILES: [(&str, &str, &str); 9] = [
    ("/", "public/index.html", "text/html; charset=utf-8"),
    ("/app.js", "public/app.js", "text/javascript; charset=utf-8"),
    (
        "/keys.js",
        "public/keys.js",
        "text/javascript; charset=utf-8",
    ),
    ("/style.css", "public/style.css", "text/css; charset=utf-8"),
    (
        "/apple-touch-icon.png",
        "public/apple-touch-icon.png",
        "image/png",
    ),
    (
        "/manifest.webmanifest",
        "public/manifest.webmanifest",
        "application/manifest+json; charset=utf-8",
    ),
    (
        "/vendor/xterm.mjs",
        "node_modules/@xterm/xterm/lib/xterm.mjs",
        "text/javascript; charset=utf-8",
    ),
    (
        "/vendor/xterm.css",
        "node_modules/@xterm/xterm/css/xterm.css",
        "text/css; charset=utf-8",
    ),
    (
        "/vendor/addon-fit.mjs",
        "node_modules/@xterm/addon-fit/lib/addon-fit.mjs",
        "text/javascript; charset=utf-8",
    ),
];

/// Sent with every response. Only load code from this server (xterm.js sets some styles
/// inline), and stop other sites from hiding this page inside an invisible frame.
const SECURITY_HEADERS: [(&str, &str); 4] = [
    (
        "content-security-policy",
        "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; \
         frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    ),
    ("x-frame-options", "DENY"),
    ("x-content-type-options", "nosniff"),
    ("cache-control", "no-store"),
];

/// What every request handler needs to know.
struct Site {
    /// A page on another site can make the phone's browser connect here under that site's name
    /// (DNS rebinding). Requiring the exact Host, and on the terminal connection the exact
    /// Origin, refuses those connections. ttyd's own origin check cannot, because it only
    /// compares the two headers with each other.
    expected_host: String,
    expected_origin: String,
    ttyd_socket: PathBuf,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(EXIT_CONFIG_ERROR);
        }
    };
    // Failing here (for example, Tailscale not connected yet at boot) exits with 1, which
    // systemd retries.
    let listener = match TcpListener::bind((config.listen_host, config.listen_port)).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Could not listen on port {}: {error}", config.listen_port);
            return ExitCode::FAILURE;
        }
    };
    let port = listener
        .local_addr()
        .map_or(config.listen_port, |address| address.port());
    let expected_host = match config.listen_host {
        IpAddr::V4(address) => format!("{address}:{port}"),
        IpAddr::V6(address) => format!("[{address}]:{port}"),
    };
    let site = Arc::new(Site {
        expected_origin: format!("http://{expected_host}"),
        expected_host,
        ttyd_socket: config.ttyd_socket,
    });
    println!(
        "Listening on port {port}, allowing {} device(s)",
        config.allowed_addresses.len()
    );

    let places = Arc::new(Semaphore::new(config.max_connections));
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(connection) => connection,
            Err(error) => {
                eprintln!("Could not accept a connection: {error}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        // Devices that are not allowed are dropped before a single byte is read, so they get
        // no reply to probe and never reach the request handlers.
        if !config.allowed_addresses.contains(&peer.ip()) {
            eprintln!("Refused {}", peer.ip());
            continue;
        }
        // A full gatekeeper drops new connections until an open one closes.
        let Ok(place) = Arc::clone(&places).try_acquire_owned() else {
            continue;
        };
        let place = Arc::new(place);
        let site = Arc::clone(&site);
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let (site, place) = (Arc::clone(&site), Arc::clone(&place));
                async move { Ok::<_, Infallible>(route(request, &site, place).await) }
            });
            // Errors here are a single client's problem (a reset, a malformed request), never
            // the gatekeeper's: they end that connection only.
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(IDLE_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await;
        });
    }
}

async fn route(
    request: Request<Incoming>,
    site: &Site,
    place: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Response<Full<Bytes>> {
    let host = header(&request, HOST);
    if request.headers().contains_key(UPGRADE) {
        if host != Some(site.expected_host.as_str())
            || header(&request, ORIGIN) != Some(site.expected_origin.as_str())
        {
            return reply(StatusCode::FORBIDDEN, "Forbidden");
        }
        if path_of(&request) != Some("/ws") {
            return reply(StatusCode::NOT_FOUND, "Not found");
        }
        if request.headers().contains_key(CONTENT_LENGTH)
            || request.headers().contains_key(TRANSFER_ENCODING)
        {
            return reply(StatusCode::BAD_REQUEST, "Bad request");
        }
        // The open terminal keeps its place in the connection count until it closes.
        return terminal::open(request, &site.ttyd_socket, place).await;
    }
    if host != Some(site.expected_host.as_str()) {
        return reply(StatusCode::MISDIRECTED_REQUEST, "Misdirected request");
    }
    let file =
        path_of(&request).and_then(|path| FILES.iter().find(|(served, _, _)| *served == path));
    match (request.method(), file) {
        (&Method::GET, Some((_, file_path, content_type))) => {
            match tokio::fs::read(file_path).await {
                Ok(body) => respond(StatusCode::OK, content_type, Bytes::from(body)),
                Err(error) => {
                    // A missing file (for example, node_modules not installed) must not take down the open terminals.
                    eprintln!("Could not read {file_path}: {error}");
                    reply(StatusCode::INTERNAL_SERVER_ERROR, "Server error")
                }
            }
        }
        _ => reply(StatusCode::NOT_FOUND, "Not found"),
    }
}

fn header(request: &Request<Incoming>, name: hyper::header::HeaderName) -> Option<&str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

/// The path of a plain `/...` request, or `None` for anything else. A full address such as
/// `http://host/...` or `//host/...` names some other host, so it is refused, not reinterpreted.
fn path_of(request: &Request<Incoming>) -> Option<&str> {
    let uri = request.uri();
    let path = uri.path();
    (uri.scheme().is_none() && uri.authority().is_none() && !path.starts_with("//")).then_some(path)
}

/// A short plain-text response, such as a refusal.
pub(crate) fn reply(status: StatusCode, text: &str) -> Response<Full<Bytes>> {
    respond(
        status,
        "text/plain; charset=utf-8",
        Bytes::from(format!("{text}\n")),
    )
}

fn respond(status: StatusCode, content_type: &'static str, body: Bytes) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(body));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    for (name, value) in SECURITY_HEADERS {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}
