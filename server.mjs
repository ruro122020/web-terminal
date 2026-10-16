// Gatekeeper in front of ttyd. It is the only thing reachable over Tailscale:
// it turns away every device except the allowed ones, serves the terminal page,
// and forwards the terminal connection to ttyd, which listens on a private
// socket file instead of the network.
//
// Tailscale accepts its own traffic before ufw sees it, so ufw cannot do this check.
// Tailscale addresses cannot be forged: each one is tied to a device's encryption key.

import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';

// The addresses are private network details, so they come from Bitwarden Secrets Manager
// at startup (`bws run`) and are never written in this repo.
function requiredSetting(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Start the gatekeeper through \`bws run\` so it receives its secrets.`);
    process.exit(1);
  }
  return value;
}

const LISTEN_HOST = requiredSetting('LISTEN_HOST');
const ALLOWED_ADDRESSES = new Set(requiredSetting('ALLOWED_ADDRESSES').split(','));
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 7681);
const TTYD_SOCKET = process.env.TTYD_SOCKET ?? `/run/user/${process.getuid()}/web-terminal/ttyd.sock`;

function clientAddress(socket) {
  // IPv4 clients can show up in IPv6 form, with "::ffff:" in front of the usual address.
  return socket.remoteAddress?.replace(/^::ffff:/, '');
}

function isAllowed(socket) {
  const address = clientAddress(socket);
  if (ALLOWED_ADDRESSES.has(address)) return true;
  console.warn(`Refused ${address}`);
  return false;
}

// Only these files are served; nothing else on disk is reachable.
const TEXT = (type) => `${type}; charset=utf-8`;
const FILES = {
  '/': ['public/index.html', TEXT('text/html')],
  '/app.js': ['public/app.js', TEXT('text/javascript')],
  '/style.css': ['public/style.css', TEXT('text/css')],
  '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'image/png'],
  '/vendor/xterm.mjs': ['node_modules/@xterm/xterm/lib/xterm.mjs', TEXT('text/javascript')],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', TEXT('text/css')],
  '/vendor/addon-fit.mjs': ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', TEXT('text/javascript')],
};

const SECURITY_HEADERS = {
  // Only load code from this server; xterm.js sets some styles inline.
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

const server = http.createServer(async (request, response) => {
  if (!isAllowed(request.socket)) {
    response.writeHead(403).end('Forbidden\n');
    return;
  }
  const file = request.method === 'GET' && FILES[new URL(request.url, 'http://x').pathname];
  if (!file) {
    response.writeHead(404).end('Not found\n');
    return;
  }
  const [path, type] = file;
  const body = await readFile(new URL(path, import.meta.url));
  response.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS }).end(body);
});

// The terminal itself runs over a WebSocket: an HTTP request that "upgrades" into a
// two-way stream. Replay the upgrade request to ttyd, then join the two streams.
server.on('upgrade', (request, socket, head) => {
  if (!isAllowed(socket)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  if (new URL(request.url, 'http://x').pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const upstream = net.connect(TTYD_SOCKET, () => {
    let headerLines = '';
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      headerLines += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headerLines}\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Listening on port ${LISTEN_PORT}, allowing ${ALLOWED_ADDRESSES.size} device(s)`);
});
