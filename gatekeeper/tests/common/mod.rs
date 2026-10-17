//! Shared by the gatekeeper tests. Uses only loopback addresses, never real ones.
//! Linux routes all of 127.0.0.0/8 to this machine, so 127.0.0.2 works as a second client.

#![allow(dead_code)] // each test file uses a different subset of these helpers

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
// A test that fails while holding a lock marks it "poisoned". The helpers still read it, so
// the failure is reported normally instead of a second panic aborting the whole test run.
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use socket2::{Domain, Socket, Type};
use tempfile::TempDir;

pub const THIS_MACHINE: &str = "127.0.0.1";
pub const OTHER_DEVICE: &str = "127.0.0.2";
pub const EXIT_CONFIG_ERROR: i32 = 78;

/// The `Sec-WebSocket-Key` every test handshake uses, and the `Sec-WebSocket-Accept` value that
/// proves a server understood it (RFC 6455, section 1.3). A browser rejects a 101 without it.
pub const WEBSOCKET_KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
pub const WEBSOCKET_ACCEPT: &str = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

/// The web-terminal folder, which holds `public/` and `node_modules/`.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// Waits until `check` returns true, or panics after `timeout` naming `what`.
pub fn wait_until(timeout: Duration, what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

// --- The gatekeeper program ---

/// A running gatekeeper. When dropped at the end of a test, it fails the test if the gatekeeper
/// stopped on its own along the way, then stops it.
pub struct Gatekeeper {
    child: Child,
    pub port: u16,
    stderr: Arc<Mutex<String>>,
}

impl Gatekeeper {
    /// Starts the gatekeeper with only the given settings (plus `LISTEN_PORT=0`, so it picks a
    /// free port) and waits until it reports which port it is listening on.
    pub fn start(settings: &[(&str, &str)], cwd: &Path) -> Self {
        let (mut child, stderr, stderr_reader) = spawn(settings, cwd);
        let stdout = child.stdout.take().unwrap();
        let (port_sender, port_receiver) = mpsc::channel::<Result<u16, String>>();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("Listening on port ") {
                    let port = rest.split(',').next().unwrap_or_default();
                    let _ = port_sender.send(
                        port.parse()
                            .map_err(|_| format!("could not read a port from {line:?}")),
                    );
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match port_receiver.try_recv() {
                Ok(Ok(port)) => {
                    return Self {
                        child,
                        port,
                        stderr,
                    };
                }
                Ok(Err(message)) => {
                    stop(&mut child);
                    panic!("{message}");
                }
                Err(_) => {}
            }
            if let Some(status) = child.try_wait().unwrap() {
                let _ = stderr_reader.join(); // the log is complete once the pipe closes
                panic!(
                    "gatekeeper exited with {status}: {}",
                    stderr.lock().unwrap_or_else(PoisonError::into_inner)
                );
            }
            if Instant::now() > deadline {
                stop(&mut child);
                panic!(
                    "gatekeeper did not report its port within 10 s: {}",
                    stderr.lock().unwrap_or_else(PoisonError::into_inner)
                );
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Everything the gatekeeper has written to its error log so far.
    pub fn stderr(&self) -> String {
        self.stderr
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// True while the gatekeeper process is still running.
    pub fn is_running(&mut self) -> bool {
        self.child.try_wait().unwrap().is_none()
    }
}

impl Drop for Gatekeeper {
    fn drop(&mut self) {
        let crashed = !self.is_running();
        stop(&mut self.child);
        assert!(
            !crashed || thread::panicking(),
            "the gatekeeper stopped during the test: {}",
            self.stderr()
        );
    }
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn(settings: &[(&str, &str)], cwd: &Path) -> (Child, Arc<Mutex<String>>, JoinHandle<()>) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_gatekeeper"));
    command
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("LISTEN_PORT", "0")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in settings {
        command.env(name, value);
    }
    let mut child = command
        .spawn()
        .expect("the gatekeeper program should start");
    let stderr = Arc::new(Mutex::new(String::new()));
    let collected = Arc::clone(&stderr);
    let pipe = child.stderr.take().unwrap();
    let reader = thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let mut text = collected.lock().unwrap_or_else(PoisonError::into_inner);
            text.push_str(&line);
            text.push('\n');
        }
    });
    (child, stderr, reader)
}

/// Starts the gatekeeper and asserts that it stops with `code`, logging a line containing `message`.
pub fn expect_exit(settings: &[(&str, &str)], code: i32, message: &str) {
    let (mut child, stderr, stderr_reader) = spawn(settings, &repo_root());
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            stop(&mut child);
            panic!("gatekeeper kept running; expected it to exit with {code} ({message})");
        }
        thread::sleep(Duration::from_millis(20));
    };
    let _ = stderr_reader.join(); // the log is complete once the pipe closes
    let log = stderr
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    assert_eq!(status.code(), Some(code), "exit code; log: {log}");
    assert!(
        log.contains(message),
        "expected the log to mention {message:?}; log: {log}"
    );
}

// --- A stand-in for ttyd ---

/// How the fake ttyd answers a terminal connection.
#[derive(Clone, Copy)]
pub enum TtydMode {
    /// Accept, then echo back whatever arrives, like a terminal would.
    Echo,
    /// Accept and immediately send this text in the same write as the acceptance, like ttyd's
    /// first output arriving right behind its 101; then echo.
    GreetThenEcho(&'static str),
    /// Refuse the handshake, as real ttyd does when its origin check fails.
    Refuse,
}

/// One terminal connection the fake ttyd received.
pub struct TtydConnection {
    /// The request the gatekeeper sent, up to and including the blank line after the headers.
    pub request: String,
    /// Everything received after the request.
    pub received: Vec<u8>,
    pub closed: bool,
    stream: Option<UnixStream>,
}

impl TtydConnection {
    /// The forwarded headers as (lowercase name, value) pairs.
    pub fn headers(&self) -> Vec<(String, String)> {
        self.request
            .split("\r\n")
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
            .collect()
    }
}

/// A stand-in for ttyd on a temporary socket file.
pub struct FakeTtyd {
    pub socket_path: PathBuf,
    pub connections: Arc<Mutex<Vec<TtydConnection>>>,
    stop: Arc<AtomicBool>,
    _dir: TempDir,
}

impl FakeTtyd {
    pub fn start() -> Self {
        Self::start_in_mode(TtydMode::Echo)
    }

    pub fn start_in_mode(mode: TtydMode) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("gatekeeper-test-")
            .tempdir()
            .unwrap();
        let socket_path = dir.path().join("ttyd.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let connections: Arc<Mutex<Vec<TtydConnection>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (shared, stopping) = (Arc::clone(&connections), Arc::clone(&stop));
        thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve_one(stream, &shared, mode),
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            socket_path,
            connections,
            stop,
            _dir: dir,
        }
    }

    pub fn connection_count(&self) -> usize {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    pub fn is_closed(&self, index: usize) -> bool {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(index)
            .is_some_and(|connection| connection.closed)
    }

    /// Ends one session from ttyd's side, as when the shell exits.
    pub fn end_session(&self, index: usize) {
        if let Some(stream) = &self
            .connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)[index]
            .stream
        {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

impl Drop for FakeTtyd {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for connection in self
            .connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
        {
            if let Some(stream) = &connection.stream {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }
}

fn serve_one(
    mut stream: UnixStream,
    connections: &Arc<Mutex<Vec<TtydConnection>>>,
    mode: TtydMode,
) {
    stream.set_nonblocking(false).unwrap();
    let index = {
        let mut list = connections.lock().unwrap_or_else(PoisonError::into_inner);
        list.push(TtydConnection {
            request: String::new(),
            received: Vec::new(),
            closed: false,
            stream: stream.try_clone().ok(),
        });
        list.len() - 1
    };
    let connections = Arc::clone(connections);
    thread::spawn(move || {
        let mut head = Vec::new();
        let mut buffer = [0u8; 4096];
        let mut upgraded = false;
        loop {
            let read = match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            if upgraded {
                connections.lock().unwrap_or_else(PoisonError::into_inner)[index]
                    .received
                    .extend_from_slice(&buffer[..read]);
                if stream.write_all(&buffer[..read]).is_err() {
                    break;
                }
                continue;
            }
            head.extend_from_slice(&buffer[..read]);
            let Some(end) = find(&head, b"\r\n\r\n") else {
                continue;
            };
            let rest = head.split_off(end + 4);
            {
                let mut list = connections.lock().unwrap_or_else(PoisonError::into_inner);
                list[index].request = String::from_utf8_lossy(&head).into_owned();
                list[index].received.extend_from_slice(&rest);
            }
            let mut reply = match mode {
                TtydMode::Refuse => {
                    let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    break;
                }
                TtydMode::Echo | TtydMode::GreetThenEcho(_) => format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
                     Sec-WebSocket-Accept: {WEBSOCKET_ACCEPT}\r\nSec-WebSocket-Protocol: tty\r\n\r\n"
                )
                .into_bytes(),
            };
            if let TtydMode::GreetThenEcho(greeting) = mode {
                reply.extend_from_slice(greeting.as_bytes()); // same write as the 101
            }
            reply.extend_from_slice(&rest); // echo anything that arrived with the request
            if stream.write_all(&reply).is_err() {
                break;
            }
            upgraded = true;
        }
        // Close like real ttyd does once the gatekeeper's side has finished.
        let _ = stream.shutdown(Shutdown::Both);
        connections.lock().unwrap_or_else(PoisonError::into_inner)[index].closed = true;
    });
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// --- Clients ---

/// Connects to the gatekeeper at `host` from the local address `from`.
pub fn connect(host: &str, port: u16, from: &str) -> std::io::Result<TcpStream> {
    let target: IpAddr = host.parse().unwrap();
    let domain = if target.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, None)?;
    socket.bind(&SocketAddr::new(from.parse().unwrap(), 0).into())?;
    socket.connect_timeout(
        &SocketAddr::new(target, port).into(),
        Duration::from_secs(3),
    )?;
    let stream: TcpStream = socket.into();
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    Ok(stream)
}

/// Connects to the gatekeeper on 127.0.0.1 from the given local address (127.0.0.1 or 127.0.0.2).
pub fn connect_from(port: u16, from: &str) -> std::io::Result<TcpStream> {
    connect(THIS_MACHINE, port, from)
}

/// Cuts a connection abruptly (a TCP reset), as when a phone drops off Wi-Fi.
pub fn reset(stream: TcpStream) {
    let socket = Socket::from(stream);
    let _ = socket.set_linger(Some(Duration::ZERO));
    drop(socket);
}

pub struct Response {
    pub status: u16,
    /// Header names are lowercase.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// An HTTP request from 127.0.0.1, with Host set to "127.0.0.1:<port>" unless `headers`
/// sets it. The path is sent exactly as given.
pub fn request(port: u16, method: &str, path: &str, headers: &[(&str, &str)]) -> Response {
    request_from(port, method, path, headers, THIS_MACHINE)
}

pub fn request_from(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    from: &str,
) -> Response {
    let mut text = format!("{method} {path} HTTP/1.1\r\n");
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("host"))
    {
        let _ = write!(text, "Host: {THIS_MACHINE}:{port}\r\n");
    }
    for (name, value) in headers {
        let _ = write!(text, "{name}: {value}\r\n");
    }
    text.push_str("Connection: close\r\n\r\n");
    send_and_read(THIS_MACHINE, port, from, &text, &format!("{method} {path}"))
}

/// Sends a complete request exactly as written and reads the whole response.
pub fn send_and_read(host: &str, port: u16, from: &str, text: &str, what: &str) -> Response {
    let mut stream = connect(host, port, from)
        .unwrap_or_else(|error| panic!("{what}: could not connect: {error}"));
    stream.write_all(text.as_bytes()).unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap_or_else(|error| {
        panic!("{what}: the response did not end (is Connection: close ignored?): {error}")
    });
    parse_response(&raw, what)
}

fn parse_response(raw: &[u8], what: &str) -> Response {
    let end = find(raw, b"\r\n\r\n").unwrap_or_else(|| {
        panic!(
            "{what}: incomplete response: {:?}",
            String::from_utf8_lossy(raw)
        )
    });
    let head = String::from_utf8_lossy(&raw[..end]);
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let raw_body = &raw[end + 4..];
    let body = if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        decode_chunked(raw_body, what)
    } else {
        raw_body.to_vec()
    };
    Response {
        status,
        headers,
        body,
    }
}

/// Decodes a body sent in length-prefixed pieces (chunked transfer encoding).
fn decode_chunked(mut raw: &[u8], what: &str) -> Vec<u8> {
    let mut body = Vec::new();
    loop {
        let line_end = find(raw, b"\r\n").unwrap_or_else(|| panic!("{what}: broken chunked body"));
        let size_text = String::from_utf8_lossy(&raw[..line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap().trim(), 16)
            .unwrap_or_else(|_| panic!("{what}: bad chunk size {size_text:?}"));
        raw = &raw[line_end + 2..];
        if size == 0 {
            return body;
        }
        body.extend_from_slice(&raw[..size]);
        raw = &raw[size + 2..];
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The gatekeeper closed the connection.
    Closed,
    /// Nothing more arrived for 1 second while the connection stayed open.
    Timeout,
}

/// Sends raw bytes and collects what comes back until the gatekeeper closes or goes quiet.
pub fn raw_exchange(port: u16, bytes: &[u8], from: &str) -> (String, Ended) {
    let Ok(mut stream) = connect_from(port, from) else {
        return (String::new(), Ended::Closed);
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let _ = stream.write_all(bytes);
    let mut received = Vec::new();
    let mut buffer = [0u8; 4096];
    let ended = loop {
        match stream.read(&mut buffer) {
            Ok(0) => break Ended::Closed,
            Ok(read) => received.extend_from_slice(&buffer[..read]),
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                break Ended::Timeout;
            }
            Err(_) => break Ended::Closed,
        }
    };
    (String::from_utf8_lossy(&received).into_owned(), ended)
}

/// A WebSocket upgrade request as a browser on the page would send it.
pub struct Upgrade {
    pub path: String,
    pub host: String,
    /// `None` leaves the Origin header out.
    pub origin: Option<String>,
    pub extra_headers: Vec<String>,
}

impl Upgrade {
    pub fn new(port: u16) -> Self {
        Self::for_host(&format!("{THIS_MACHINE}:{port}"))
    }

    /// For a gatekeeper reached as `host`, such as `127.0.0.1:1234` or `[::1]:1234`.
    pub fn for_host(host: &str) -> Self {
        Self {
            path: "/ws".into(),
            origin: Some(format!("http://{host}")),
            host: host.into(),
            extra_headers: Vec::new(),
        }
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut lines = vec![
            format!("GET {} HTTP/1.1", self.path),
            format!("Host: {}", self.host),
        ];
        if let Some(origin) = &self.origin {
            lines.push(format!("Origin: {origin}"));
        }
        lines.extend([
            "Connection: Upgrade".to_string(),
            "Upgrade: websocket".to_string(),
            "Sec-WebSocket-Version: 13".to_string(),
            format!("Sec-WebSocket-Key: {WEBSOCKET_KEY}"),
            "Sec-WebSocket-Protocol: tty".to_string(),
        ]);
        lines.extend(self.extra_headers.iter().cloned());
        format!("{}\r\n\r\n", lines.join("\r\n")).into_bytes()
    }
}

/// Sends `bytes` (an upgrade request, possibly followed by data) on a new connection and
/// returns the connection and the reply head, up to and including the blank line.
pub fn upgrade_on(mut stream: TcpStream, bytes: &[u8]) -> (TcpStream, String) {
    stream.write_all(bytes).unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while find(&head, b"\r\n\r\n").is_none() {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => break, // closed or timed out; the caller checks the head
        }
    }
    (stream, String::from_utf8_lossy(&head).into_owned())
}

/// The value of a header in a reply head, matching the name in any letter case.
pub fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n")
        .filter_map(|line| line.split_once(':'))
        .find(|(header, _)| header.trim().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
}

/// Opens a terminal connection through the gatekeeper and returns it once the gatekeeper has
/// answered 101 (Switching Protocols). Panics with the reply if it refused.
pub fn open_terminal(port: u16) -> TcpStream {
    let (stream, head) = upgrade_on(
        connect_from(port, THIS_MACHINE).expect("connect"),
        &Upgrade::new(port).bytes(),
    );
    assert!(
        head.starts_with("HTTP/1.1 101"),
        "upgrade refused: {head:?}"
    );
    stream
}
