//! Starts the real gatekeeper program on 127.0.0.1 with a fake ttyd behind it, then talks to it
//! over real connections. These tests describe what the gatekeeper must do. Every test also fails
//! if the gatekeeper stopped on its own while it ran (see `Drop for Gatekeeper`).

mod common;

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::PoisonError;
use std::thread;
use std::time::{Duration, Instant};

use common::{
    EXIT_CONFIG_ERROR, Ended, FakeTtyd, Gatekeeper, OTHER_DEVICE, THIS_MACHINE, TtydMode, Upgrade,
    WEBSOCKET_ACCEPT, WEBSOCKET_KEY, connect, connect_from, expect_exit, header_value,
    open_terminal, raw_exchange, repo_root, request, request_from, reset, send_and_read,
    upgrade_on, wait_until,
};

const EXPECTED_CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; \
                            frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// The only headers the gatekeeper may forward to ttyd.
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

const SECOND: Duration = Duration::from_secs(1);

fn start_with_ttyd(
    ttyd: FakeTtyd,
    allowed: &str,
    extra: &[(&str, &str)],
) -> (Gatekeeper, FakeTtyd) {
    let socket = ttyd.socket_path.to_str().unwrap().to_string();
    let mut settings = vec![
        ("LISTEN_HOST", THIS_MACHINE),
        ("ALLOWED_ADDRESSES", allowed),
        ("TTYD_SOCKET", socket.as_str()),
    ];
    settings.extend_from_slice(extra);
    (Gatekeeper::start(&settings, &repo_root()), ttyd)
}

fn start_with(allowed: &str, extra: &[(&str, &str)]) -> (Gatekeeper, FakeTtyd) {
    start_with_ttyd(FakeTtyd::start(), allowed, extra)
}

/// A gatekeeper allowing only 127.0.0.1, with an echoing fake ttyd behind it.
fn start() -> (Gatekeeper, FakeTtyd) {
    start_with(THIS_MACHINE, &[])
}

fn assert_still_serving(gatekeeper: &mut Gatekeeper) {
    assert!(
        gatekeeper.is_running(),
        "gatekeeper stopped: {}",
        gatekeeper.stderr()
    );
    assert_eq!(
        request(gatekeeper.port, "GET", "/", &[]).status,
        200,
        "still serving the page"
    );
}

fn assert_security_headers(response: &common::Response, what: &str) {
    let header = |name: &str| response.headers.get(name).map(String::as_str);
    assert_eq!(
        header("content-security-policy"),
        Some(EXPECTED_CSP),
        "{what}"
    );
    assert_eq!(header("x-frame-options"), Some("DENY"), "{what}");
    assert_eq!(header("x-content-type-options"), Some("nosniff"), "{what}");
    assert_eq!(header("cache-control"), Some("no-store"), "{what}");
}

/// Reads from `stream` until `expected` has arrived, or panics after 3 seconds.
fn read_exactly(stream: &mut TcpStream, expected: &[u8], what: &str) {
    let mut received = vec![0u8; expected.len()];
    stream
        .read_exact(&mut received)
        .unwrap_or_else(|error| panic!("{what}: {error}"));
    assert_eq!(
        String::from_utf8_lossy(&received),
        String::from_utf8_lossy(expected),
        "{what}"
    );
}

// --- Starting up ---

const VALID: [(&str, &str); 3] = [
    ("LISTEN_HOST", THIS_MACHINE),
    ("ALLOWED_ADDRESSES", THIS_MACHINE),
    ("TTYD_SOCKET", "/nonexistent.sock"),
];

/// The valid settings with `name` set to `value` (replaced, or added if it is not one of them).
fn valid_with<'a>(name: &'a str, value: &'a str) -> Vec<(&'a str, &'a str)> {
    let mut settings: Vec<_> = VALID.iter().copied().filter(|(n, _)| *n != name).collect();
    settings.push((name, value));
    settings
}

#[test]
fn stops_with_a_configuration_error_when_a_setting_is_missing() {
    for missing in ["LISTEN_HOST", "ALLOWED_ADDRESSES", "TTYD_SOCKET"] {
        let settings: Vec<_> = VALID
            .iter()
            .copied()
            .filter(|(name, _)| *name != missing)
            .collect();
        expect_exit(&settings, EXIT_CONFIG_ERROR, &format!("Missing {missing}"));
    }
}

#[test]
fn stops_with_a_configuration_error_when_settings_are_invalid() {
    expect_exit(
        &valid_with("LISTEN_HOST", "localhost"),
        EXIT_CONFIG_ERROR,
        "LISTEN_HOST must be an IP address",
    );
    expect_exit(
        &valid_with("ALLOWED_ADDRESSES", "127.0.0.1,my-phone"),
        EXIT_CONFIG_ERROR,
        "ALLOWED_ADDRESSES must be",
    );
    expect_exit(
        &valid_with("ALLOWED_ADDRESSES", " , "),
        EXIT_CONFIG_ERROR,
        "ALLOWED_ADDRESSES must be",
    );
    expect_exit(
        &valid_with("MAX_CONNECTIONS", "lots"),
        EXIT_CONFIG_ERROR,
        "MAX_CONNECTIONS must be",
    );
    expect_exit(
        &valid_with("MAX_CONNECTIONS", "0"),
        EXIT_CONFIG_ERROR,
        "MAX_CONNECTIONS must be",
    );
}

#[test]
fn listens_only_on_listen_host_not_on_other_addresses_of_this_computer() {
    let (gatekeeper, _ttyd) = start();
    let error = TcpStream::connect((OTHER_DEVICE, gatekeeper.port))
        .expect_err("another address of this computer must not answer");
    assert_eq!(error.kind(), std::io::ErrorKind::ConnectionRefused);
}

#[test]
fn works_on_an_ipv6_address_with_the_bracketed_host_and_origin_browsers_send() {
    let ttyd = FakeTtyd::start();
    let socket = ttyd.socket_path.to_str().unwrap().to_string();
    let gatekeeper = Gatekeeper::start(
        &[
            ("LISTEN_HOST", "::1"),
            ("ALLOWED_ADDRESSES", "::1"),
            ("TTYD_SOCKET", &socket),
        ],
        &repo_root(),
    );
    let host = format!("[::1]:{}", gatekeeper.port);
    let page = send_and_read(
        "::1",
        gatekeeper.port,
        "::1",
        &format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
        "IPv6 page",
    );
    assert_eq!(page.status, 200);
    let (_terminal, head) = upgrade_on(
        connect("::1", gatekeeper.port, "::1").unwrap(),
        &Upgrade::for_host(&host).bytes(),
    );
    assert!(
        head.starts_with("HTTP/1.1 101"),
        "IPv6 terminal connection: {head:?}"
    );
}

// --- Which devices get in ---

#[test]
fn the_allowed_device_gets_in_and_every_other_device_is_dropped_without_a_reply() {
    let (gatekeeper, ttyd) = start();
    let port = gatekeeper.port;
    assert_eq!(request(port, "GET", "/", &[]).status, 200, "allowed device");

    let page = format!("GET / HTTP/1.1\r\nHost: {THIS_MACHINE}:{port}\r\n\r\n");
    assert_eq!(
        raw_exchange(port, page.as_bytes(), OTHER_DEVICE),
        (String::new(), Ended::Closed),
        "page request from another device"
    );
    assert_eq!(
        raw_exchange(port, &Upgrade::new(port).bytes(), OTHER_DEVICE),
        (String::new(), Ended::Closed),
        "terminal request from another device"
    );
    assert_eq!(ttyd.connection_count(), 0, "nothing reached ttyd");

    wait_until(3 * SECOND, "the refusal to be logged", || {
        gatekeeper
            .stderr()
            .contains(&format!("Refused {OTHER_DEVICE}"))
    });
}

#[test]
fn several_devices_can_be_allowed_with_or_without_spaces_after_the_commas() {
    let (gatekeeper, _ttyd) = start_with(&format!("{OTHER_DEVICE}, {THIS_MACHINE} ,"), &[]);
    assert_eq!(request(gatekeeper.port, "GET", "/", &[]).status, 200);
    assert_eq!(
        request_from(gatekeeper.port, "GET", "/", &[], OTHER_DEVICE).status,
        200
    );
}

// --- Requests that use another site's name (DNS rebinding) ---

#[test]
fn page_requests_addressed_to_any_other_host_name_are_refused() {
    let (gatekeeper, _ttyd) = start();
    let port = gatekeeper.port;
    for host in [
        format!("evil.example:{port}"),
        format!("{THIS_MACHINE}:1"),
        THIS_MACHINE.to_string(),
    ] {
        let response = request(port, "GET", "/", &[("Host", &host)]);
        assert_eq!(response.status, 421, "Host: {host}");
        assert_security_headers(&response, &format!("421 for Host: {host}"));
    }
    let no_host = send_and_read(
        THIS_MACHINE,
        port,
        THIS_MACHINE,
        "GET / HTTP/1.1\r\nConnection: close\r\n\r\n",
        "no Host",
    );
    // Refused either by the gatekeeper's Host check (421) or by the HTTP library before it (400).
    assert!(
        matches!(no_host.status, 400 | 421),
        "a request without a Host header got {}",
        no_host.status
    );
}

#[test]
fn terminal_connections_need_the_exact_host_and_origin_of_this_page() {
    let (gatekeeper, ttyd) = start();
    let port = gatekeeper.port;
    let page_host = format!("{THIS_MACHINE}:{port}");
    let attempts = [
        (
            "rebinding: both headers name the attacker",
            format!("evil.example:{port}"),
            Some(format!("http://evil.example:{port}")),
        ),
        (
            "another site",
            page_host.clone(),
            Some("http://evil.example".to_string()),
        ),
        ("no Origin", page_host.clone(), None),
        (
            "wrong port",
            page_host.clone(),
            Some(format!("http://{THIS_MACHINE}:1")),
        ),
        (
            "wrong scheme",
            page_host.clone(),
            Some(format!("https://{page_host}")),
        ),
    ];
    for (name, host, origin) in attempts {
        let upgrade = Upgrade {
            host,
            origin,
            ..Upgrade::new(port)
        };
        let (reply, _) = raw_exchange(port, &upgrade.bytes(), THIS_MACHINE);
        assert!(reply.starts_with("HTTP/1.1 403"), "{name}: got {reply:?}");
    }
    assert_eq!(ttyd.connection_count(), 0, "nothing reached ttyd");
}

// --- Page files ---

#[test]
fn every_page_file_is_served_with_its_exact_contents_type_and_security_headers() {
    let (gatekeeper, _ttyd) = start();
    let files = [
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
    for (path, file, content_type) in files {
        let response = request(gatekeeper.port, "GET", path, &[]);
        assert_eq!(response.status, 200, "{path}");
        assert_eq!(
            response.headers.get("content-type").map(String::as_str),
            Some(content_type),
            "{path}"
        );
        assert!(
            response.body == fs::read(repo_root().join(file)).unwrap(),
            "{path} serves exactly {file}"
        );
        assert_security_headers(&response, path);
    }
    assert_eq!(
        request(gatekeeper.port, "GET", "/?v=1", &[]).status,
        200,
        "a query string does not change the file"
    );
}

#[test]
fn anything_else_is_404_with_the_same_security_headers_including_path_tricks() {
    let (gatekeeper, _ttyd) = start();
    for path in [
        "/server.mjs",
        "/../server.mjs",
        "/%2e%2e/server.mjs",
        "/public/app.js",
        "/node_modules/@xterm/xterm/package.json",
        "/vendor/../server.mjs",
        "//evil.example/",
        "/token",
        "/gatekeeper/Cargo.toml",
    ] {
        let response = request(gatekeeper.port, "GET", path, &[]);
        assert_eq!(response.status, 404, "{path}");
        assert_security_headers(&response, path);
    }
}

#[test]
fn only_get_is_answered() {
    let (gatekeeper, _ttyd) = start();
    for method in ["POST", "PUT", "HEAD"] {
        let response = request(gatekeeper.port, method, "/", &[("Content-Length", "0")]);
        assert_eq!(response.status, 404, "{method}");
    }
}

#[test]
fn a_page_file_that_cannot_be_read_gives_500_without_stopping_the_gatekeeper() {
    // The gatekeeper serves from its working directory. A copy of the page without
    // node_modules, as if `npm ci` was never run.
    let copy = tempfile::Builder::new()
        .prefix("gatekeeper-copy-")
        .tempdir()
        .unwrap();
    fs::create_dir(copy.path().join("public")).unwrap();
    for entry in fs::read_dir(repo_root().join("public")).unwrap() {
        let entry = entry.unwrap();
        fs::copy(
            entry.path(),
            copy.path().join("public").join(entry.file_name()),
        )
        .unwrap();
    }
    let ttyd = FakeTtyd::start();
    let socket = ttyd.socket_path.to_str().unwrap().to_string();
    let mut gatekeeper = Gatekeeper::start(
        &[
            ("LISTEN_HOST", THIS_MACHINE),
            ("ALLOWED_ADDRESSES", THIS_MACHINE),
            ("TTYD_SOCKET", &socket),
        ],
        copy.path(),
    );
    let response = request(gatekeeper.port, "GET", "/vendor/xterm.mjs", &[]);
    assert_eq!(response.status, 500);
    assert_security_headers(&response, "500");
    wait_until(3 * SECOND, "the error to be logged", || {
        gatekeeper.stderr().contains("Could not read node_modules")
    });
    assert_still_serving(&mut gatekeeper);
}

// --- The terminal connection ---

#[test]
fn the_browser_gets_a_complete_handshake_it_will_accept() {
    let (gatekeeper, _ttyd) = start();
    let (_terminal, head) = upgrade_on(
        connect_from(gatekeeper.port, THIS_MACHINE).unwrap(),
        &Upgrade::new(gatekeeper.port).bytes(),
    );
    assert!(head.starts_with("HTTP/1.1 101"), "{head:?}");
    // Without the exact Accept value, the browser refuses the connection.
    assert_eq!(
        header_value(&head, "sec-websocket-accept"),
        Some(WEBSOCKET_ACCEPT),
        "{head:?}"
    );
    assert_eq!(
        header_value(&head, "sec-websocket-protocol"),
        Some("tty"),
        "{head:?}"
    );
    assert!(
        header_value(&head, "upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket")),
        "{head:?}"
    );
}

#[test]
fn ws_reaches_ttyd_as_a_clean_request_with_only_the_headers_ttyd_needs() {
    let (gatekeeper, ttyd) = start();
    let port = gatekeeper.port;
    let upgrade = Upgrade {
        extra_headers: vec!["X-Injected: yes".into(), "Cookie: a=b".into()],
        ..Upgrade::new(port)
    };
    let (_terminal, head) = upgrade_on(connect_from(port, THIS_MACHINE).unwrap(), &upgrade.bytes());
    assert!(head.starts_with("HTTP/1.1 101"), "{head:?}");
    wait_until(3 * SECOND, "ttyd to receive the connection", || {
        ttyd.connection_count() == 1
    });

    let connections = ttyd
        .connections
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let request_line = connections[0]
        .request
        .split("\r\n")
        .next()
        .unwrap()
        .to_ascii_lowercase();
    assert_eq!(request_line, "get /ws http/1.1");
    let headers = connections[0].headers();
    for (name, _) in &headers {
        assert!(
            FORWARDED_HEADERS.contains(&name.as_str()),
            "{name} must not be forwarded; got {headers:?}"
        );
    }
    let value = |name: &str| {
        headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.to_ascii_lowercase())
    };
    // ttyd compares Host with Origin, and refuses the handshake without the rest.
    assert_eq!(value("host"), Some(format!("{THIS_MACHINE}:{port}")));
    assert_eq!(
        value("origin"),
        Some(format!("http://{THIS_MACHINE}:{port}"))
    );
    assert_eq!(value("upgrade").as_deref(), Some("websocket"));
    assert_eq!(value("connection").as_deref(), Some("upgrade"));
    assert_eq!(value("sec-websocket-version").as_deref(), Some("13"));
    assert_eq!(
        value("sec-websocket-key"),
        Some(WEBSOCKET_KEY.to_ascii_lowercase())
    );
    assert_eq!(value("sec-websocket-protocol").as_deref(), Some("tty"));
}

#[test]
fn when_ttyd_refuses_the_handshake_the_browser_is_refused_too() {
    let (gatekeeper, ttyd) =
        start_with_ttyd(FakeTtyd::start_in_mode(TtydMode::Refuse), THIS_MACHINE, &[]);
    let (reply, _) = raw_exchange(
        gatekeeper.port,
        &Upgrade::new(gatekeeper.port).bytes(),
        THIS_MACHINE,
    );
    assert!(
        !reply.starts_with("HTTP/1.1 101"),
        "no terminal connection when ttyd refuses: {reply:?}"
    );
    assert_eq!(ttyd.connection_count(), 1);
}

#[test]
fn the_terminal_connection_carries_data_both_ways_and_stays_open() {
    let (gatekeeper, ttyd) = start();
    let mut terminal = open_terminal(gatekeeper.port);
    terminal.write_all(b"ls -la\r").unwrap();
    read_exactly(
        &mut terminal,
        b"ls -la\r",
        "ttyd's echo comes back through the gatekeeper",
    );
    assert_eq!(
        ttyd.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)[0]
            .received,
        b"ls -la\r"
    );

    thread::sleep(Duration::from_millis(1500)); // a quick check, not proof that there is no idle timeout
    terminal.write_all(b"pwd\r").unwrap();
    read_exactly(&mut terminal, b"pwd\r", "still open after a pause");
}

#[test]
fn data_arriving_together_with_either_handshake_is_not_lost() {
    // ttyd's first output in the same packet as its acceptance.
    let (gatekeeper, _ttyd) = start_with_ttyd(
        FakeTtyd::start_in_mode(TtydMode::GreetThenEcho("welcome\r\n")),
        THIS_MACHINE,
        &[],
    );
    let mut terminal = open_terminal(gatekeeper.port);
    read_exactly(&mut terminal, b"welcome\r\n", "ttyd's first output");

    // The browser's first input in the same packet as its upgrade request.
    let mut early = Upgrade::new(gatekeeper.port).bytes();
    early.extend_from_slice(b"early");
    let (mut terminal, head) =
        upgrade_on(connect_from(gatekeeper.port, THIS_MACHINE).unwrap(), &early);
    assert!(head.starts_with("HTTP/1.1 101"), "{head:?}");
    read_exactly(
        &mut terminal,
        b"welcome\r\nearly",
        "the greeting, then the early input echoed",
    );
}

#[test]
fn closing_the_page_closes_the_ttyd_session_so_no_shell_is_left_running() {
    let (gatekeeper, ttyd) = start();
    let terminal = open_terminal(gatekeeper.port);
    wait_until(3 * SECOND, "the ttyd connection", || {
        ttyd.connection_count() == 1
    });
    terminal.shutdown(std::net::Shutdown::Write).unwrap();
    wait_until(3 * SECOND, "the ttyd side to close", || ttyd.is_closed(0));
}

#[test]
fn when_ttyd_ends_the_session_the_page_is_disconnected() {
    let (gatekeeper, ttyd) = start();
    let mut terminal = open_terminal(gatekeeper.port);
    wait_until(3 * SECOND, "the ttyd connection", || {
        ttyd.connection_count() == 1
    });
    ttyd.end_session(0);
    let mut buffer = [0u8; 16];
    assert_eq!(
        terminal
            .read(&mut buffer)
            .expect("the page sees the session end"),
        0,
        "connection closed"
    );
}

#[test]
fn upgrade_requests_to_any_other_path_or_with_a_body_never_reach_ttyd() {
    let (gatekeeper, ttyd) = start();
    let port = gatekeeper.port;
    for path in ["/", "/token", "/ws/../ws2", "//token/../ws"] {
        let upgrade = Upgrade {
            path: path.into(),
            ..Upgrade::new(port)
        };
        let (reply, _) = raw_exchange(port, &upgrade.bytes(), THIS_MACHINE);
        assert!(reply.starts_with("HTTP/1.1 404"), "{path}: {reply:?}");
    }
    let mut with_length = Upgrade {
        extra_headers: vec!["Content-Length: 5".into()],
        ..Upgrade::new(port)
    }
    .bytes();
    with_length.extend_from_slice(b"hello");
    let (reply, _) = raw_exchange(port, &with_length, THIS_MACHINE);
    assert!(
        reply.starts_with("HTTP/1.1 400"),
        "Content-Length: {reply:?}"
    );
    let mut chunked = Upgrade {
        extra_headers: vec!["Transfer-Encoding: chunked".into()],
        ..Upgrade::new(port)
    }
    .bytes();
    chunked.extend_from_slice(b"5\r\nhello\r\n0\r\n\r\n");
    let (reply, _) = raw_exchange(port, &chunked, THIS_MACHINE);
    assert!(
        reply.starts_with("HTTP/1.1 400"),
        "Transfer-Encoding: {reply:?}"
    );
    assert_eq!(ttyd.connection_count(), 0);
}

#[test]
fn when_ttyd_is_not_running_the_terminal_connection_is_refused_and_the_gatekeeper_keeps_going() {
    let missing = tempfile::Builder::new()
        .prefix("gatekeeper-test-")
        .tempdir()
        .unwrap();
    let socket = missing.path().join("ttyd.sock");
    let mut gatekeeper = Gatekeeper::start(
        &[
            ("LISTEN_HOST", THIS_MACHINE),
            ("ALLOWED_ADDRESSES", THIS_MACHINE),
            ("TTYD_SOCKET", socket.to_str().unwrap()),
        ],
        &repo_root(),
    );
    let (reply, ended) = raw_exchange(
        gatekeeper.port,
        &Upgrade::new(gatekeeper.port).bytes(),
        THIS_MACHINE,
    );
    // Either closed without a reply, or an error reply (such as 502); never a terminal, never left hanging.
    let error_reply = reply.starts_with("HTTP/1.1 5");
    assert!(
        (reply.is_empty() && ended == Ended::Closed) || error_reply,
        "got {reply:?}, {ended:?}"
    );
    assert_still_serving(&mut gatekeeper);
}

// --- Staying up ---

#[test]
fn malformed_requests_do_not_stop_the_gatekeeper() {
    let (mut gatekeeper, _ttyd) = start();
    let port = gatekeeper.port;
    raw_exchange(
        port,
        format!("GET http://[ HTTP/1.1\r\nHost: {THIS_MACHINE}:{port}\r\n\r\n").as_bytes(),
        THIS_MACHINE,
    );
    raw_exchange(
        port,
        &Upgrade {
            path: "http://[".into(),
            ..Upgrade::new(port)
        }
        .bytes(),
        THIS_MACHINE,
    );
    raw_exchange(
        port,
        b"\x16\x03\x01\x02\x00 not http at all\r\n\r\n",
        THIS_MACHINE,
    );
    assert_still_serving(&mut gatekeeper);
}

#[test]
fn clients_that_disconnect_abruptly_do_not_stop_the_gatekeeper() {
    let (mut gatekeeper, _ttyd) = start();
    let port = gatekeeper.port;
    // An open terminal connection that is suddenly cut, as when a phone drops off Wi-Fi.
    reset(open_terminal(port));
    // A device that is not allowed, cutting its connection while being dropped.
    if let Ok(mut refused) = connect_from(port, OTHER_DEVICE) {
        let _ = refused.write_all(&Upgrade::new(port).bytes());
        reset(refused);
    }
    // Refused terminal requests cut the moment the refusal arrives. Several attempts,
    // because the crash this guards against depends on timing.
    for _ in 0..10 {
        let mut cut = connect_from(port, THIS_MACHINE).unwrap();
        let bad_origin = Upgrade {
            origin: Some("http://evil.example".into()),
            ..Upgrade::new(port)
        };
        cut.write_all(&bad_origin.bytes()).unwrap();
        let mut first = [0u8; 1];
        let _ = cut.read(&mut first);
        reset(cut);
    }
    thread::sleep(Duration::from_millis(300));
    assert_still_serving(&mut gatekeeper);
}

/// Opens a terminal connection, retrying for up to 3 seconds while a place is being freed.
fn open_terminal_when_possible(port: u16) -> TcpStream {
    let deadline = Instant::now() + 3 * SECOND;
    loop {
        let (stream, head) = upgrade_on(
            connect_from(port, THIS_MACHINE).unwrap(),
            &Upgrade::new(port).bytes(),
        );
        if head.starts_with("HTTP/1.1 101") {
            return stream;
        }
        assert!(
            Instant::now() < deadline,
            "no place freed within 3 s; last reply {head:?}"
        );
        thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn connections_are_limited_and_closed_ones_free_their_place() {
    let (gatekeeper, ttyd) = start_with(THIS_MACHINE, &[("MAX_CONNECTIONS", "2")]);
    let port = gatekeeper.port;
    let first = open_terminal(port);
    let second = open_terminal(port);
    assert_eq!(
        raw_exchange(port, &Upgrade::new(port).bytes(), THIS_MACHINE),
        (String::new(), Ended::Closed),
        "a third connection is dropped"
    );

    drop(first);
    wait_until(3 * SECOND, "the first session to close", || {
        ttyd.is_closed(0)
    });
    drop(open_terminal_when_possible(port));
    drop(second);
}

#[test]
fn twenty_connections_are_allowed_when_no_limit_is_set() {
    let (gatekeeper, _ttyd) = start();
    let port = gatekeeper.port;
    let open: Vec<TcpStream> = (0..20).map(|_| open_terminal(port)).collect();
    assert_eq!(
        raw_exchange(port, &Upgrade::new(port).bytes(), THIS_MACHINE),
        (String::new(), Ended::Closed),
        "the 21st is dropped"
    );
    drop(open);
}
