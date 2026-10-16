// Gatekeeper in front of ttyd. It is the only thing reachable over Tailscale:
// it drops every device except the allowed ones, serves the terminal page,
// and forwards the terminal connection to ttyd, which listens on a private
// socket file instead of the network.
//
// Tailscale accepts its own traffic before ufw sees it, so ufw cannot do this check.
// Tailscale addresses cannot be forged: each one is tied to a device's encryption key.

import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream';
import { readFile } from 'node:fs/promises';

// systemd is told not to restart on this exit code, so a missing secret stops the
// service instead of calling Bitwarden every few seconds forever.
const EXIT_CONFIG_ERROR = 78;

function configError(message) {
  console.error(message);
  process.exit(EXIT_CONFIG_ERROR);
}

// The addresses are private network details, so they come from Bitwarden Secrets Manager
// at startup (`bws run`) and are never written in this repo.
function requiredSetting(name) {
  const value = process.env[name]?.trim();
  if (!value) configError(`Missing ${name}. Start the gatekeeper through \`bws run\` so it receives its secrets.`);
  return value;
}

function addressList(name) {
  const addresses = requiredSetting(name).split(',').map((entry) => entry.trim()).filter(Boolean);
  const invalid = addresses.filter((address) => !net.isIP(address));
  if (addresses.length === 0 || invalid.length > 0) configError(`${name} must be a comma-separated list of IP addresses.`);
  return new Set(addresses);
}

const LISTEN_HOST = requiredSetting('LISTEN_HOST');
if (!net.isIP(LISTEN_HOST)) configError('LISTEN_HOST must be an IP address.');
const ALLOWED_ADDRESSES = addressList('ALLOWED_ADDRESSES');
const TTYD_SOCKET = requiredSetting('TTYD_SOCKET');
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 7681);
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS ?? 20);

// Only these files are served; nothing else on disk is reachable.
const TEXT = (type) => `${type}; charset=utf-8`;
const FILES = {
  '/': ['public/index.html', TEXT('text/html')],
  '/app.js': ['public/app.js', TEXT('text/javascript')],
  '/keys.js': ['public/keys.js', TEXT('text/javascript')],
  '/style.css': ['public/style.css', TEXT('text/css')],
  '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'image/png'],
  '/manifest.webmanifest': ['public/manifest.webmanifest', TEXT('application/manifest+json')],
  '/vendor/xterm.mjs': ['node_modules/@xterm/xterm/lib/xterm.mjs', TEXT('text/javascript')],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', TEXT('text/css')],
  '/vendor/addon-fit.mjs': ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', TEXT('text/javascript')],
};

const SECURITY_HEADERS = {
  // Only load code from this server; xterm.js sets some styles inline. frame-ancestors
  // stops other sites from hiding this page inside an invisible frame.
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

// Only the headers ttyd needs to accept a WebSocket are forwarded to it.
const FORWARDED_UPGRADE_HEADERS = [
  'host', 'origin', 'upgrade', 'connection',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions',
];

/** The path part of a request, or null for anything that is not a plain "/..." path. */
function pathOf(request) {
  // "//host/..." would be read as a different host, so it is refused rather than reinterpreted.
  if (!request.url.startsWith('/') || request.url.startsWith('//')) return null;
  try {
    return new URL(request.url, 'http://placeholder').pathname;
  } catch {
    return null;
  }
}

// A page on another site can make the phone's browser connect here under that site's name
// (DNS rebinding). Requiring the exact Host, and on the terminal connection the exact
// Origin, refuses those connections. ttyd's own origin check cannot, because it only
// compares the two headers with each other.
let expectedHost;
let expectedOrigin;

function reply(response, status, text) {
  response.writeHead(status, { 'Content-Type': TEXT('text/plain'), ...SECURITY_HEADERS }).end(`${text}\n`);
}

function refuseUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const server = http.createServer(async (request, response) => {
  if (request.headers.host !== expectedHost) return reply(response, 421, 'Misdirected request');
  const path = pathOf(request);
  if (request.method !== 'GET' || !Object.hasOwn(FILES, path)) return reply(response, 404, 'Not found');
  const [filePath, type] = FILES[path];
  try {
    const body = await readFile(new URL(filePath, import.meta.url));
    response.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS }).end(body);
  } catch (error) {
    // A missing file (for example, node_modules not installed) must not take down the open terminals.
    console.error(`Could not read ${filePath}: ${error.message}`);
    reply(response, 500, 'Server error');
  }
});

server.maxConnections = MAX_CONNECTIONS;

// Devices that are not allowed are dropped before a single byte of HTTP is read, so they
// get no reply to probe and never reach the request handlers.
server.on('connection', (socket) => {
  // A client that disconnects abruptly raises an error on its socket. Without a listener,
  // that error would stop the whole gatekeeper and every open terminal with it.
  socket.on('error', () => socket.destroy());
  if (!ALLOWED_ADDRESSES.has(socket.remoteAddress)) {
    console.warn(`Refused ${socket.remoteAddress}`);
    socket.destroy();
  }
});

// The terminal itself runs over a WebSocket: an HTTP request that "upgrades" into a
// two-way stream. Send ttyd a clean upgrade request, then join the two streams.
server.on('upgrade', (request, socket, head) => {
  if (request.headers.host !== expectedHost || request.headers.origin !== expectedOrigin) {
    return refuseUpgrade(socket, 403, 'Forbidden');
  }
  if (pathOf(request) !== '/ws') return refuseUpgrade(socket, 404, 'Not Found');
  if (request.headers['content-length'] || request.headers['transfer-encoding']) {
    return refuseUpgrade(socket, 400, 'Bad Request');
  }
  const headerLines = FORWARDED_UPGRADE_HEADERS
    .filter((name) => request.headers[name] !== undefined)
    .map((name) => `${name}: ${request.headers[name]}\r\n`)
    .join('');
  // Writes made before the socket file connects are held until it does.
  const upstream = net.connect(TTYD_SOCKET);
  upstream.write(`GET /ws HTTP/1.1\r\n${headerLines}\r\n`);
  upstream.write(head);
  // pipeline joins the streams and closes both when either one ends or fails.
  pipeline(socket, upstream, socket, () => {});
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  const { port } = server.address();
  const host = net.isIPv6(LISTEN_HOST) ? `[${LISTEN_HOST}]` : LISTEN_HOST;
  expectedHost = `${host}:${port}`;
  expectedOrigin = `http://${expectedHost}`;
  console.log(`Listening on port ${port}, allowing ${ALLOWED_ADDRESSES.size} device(s)`);
});
