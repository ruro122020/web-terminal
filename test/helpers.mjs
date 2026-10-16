// Shared by the gatekeeper and browser tests. Uses only loopback addresses, never real ones.
// Linux routes all of 127.0.0.0/8 to this machine, so 127.0.0.2 works as a second client.

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const THIS_MACHINE = '127.0.0.1';
export const OTHER_DEVICE = '127.0.0.2';

const tempDirs = [];

/** A new empty folder, deleted by removeTempDirs(). */
export async function makeTempDir(prefix = 'web-terminal-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs() {
  return Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function tempSocketPath() {
  return join(await makeTempDir(), 'ttyd.sock');
}

/** Resolves once `check()` returns true, or rejects after `timeoutMs`. */
export async function waitUntil(check, timeoutMs = 3000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A stand-in for ttyd. It answers the WebSocket upgrade, then stays connected and echoes
 * back whatever it receives, like a terminal would. Each connection is recorded.
 */
export async function startFakeTtyd() {
  const socketPath = await tempSocketPath();
  const connections = [];
  const server = net.createServer((socket) => {
    const connection = { request: '', received: '', closed: false, socket };
    connections.push(connection);
    let upgraded = false;
    socket.on('data', (chunk) => {
      if (upgraded) {
        connection.received += chunk;
        socket.write(chunk);
        return;
      }
      connection.request += chunk;
      const end = connection.request.indexOf('\r\n\r\n');
      if (end === -1) return;
      upgraded = true;
      // Bytes after the headers belong to the stream, not the request.
      connection.received = connection.request.slice(end + 4);
      connection.request = connection.request.slice(0, end + 4);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      if (connection.received) socket.write(connection.received);
    });
    socket.on('close', () => (connection.closed = true));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    connections,
    close: () => {
      for (const { socket } of connections) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Runs server.mjs with only the given settings. `ready` resolves with its port once it is listening. */
export function startGatekeeper(env, { cwd = REPO_ROOT } = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd,
    env: { PATH: process.env.PATH, LISTEN_PORT: '0', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/Listening on port (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    // 'close' waits for the output streams to finish, so stderr is complete in the message.
    child.on('close', (code) => reject(new Error(`gatekeeper exited with ${code}: ${stderr}`)));
  });
  ready.catch(() => {}); // callers that expect an exit check it themselves
  return {
    ready,
    child,
    output: () => ({ stdout, stderr }),
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.on('close', resolve);
      child.kill();
    }),
  };
}

/**
 * A plain HTTP request from `from` (default 127.0.0.1). The path is sent exactly as given,
 * without the cleanup fetch() would do. Node sets Host to "127.0.0.1:<port>" unless overridden.
 */
export function request(port, path, { method = 'GET', headers = {}, from = THIS_MACHINE } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: THIS_MACHINE, port, path, method, headers, localAddress: from }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(3000, () => req.destroy(new Error(`request to ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Sends raw bytes and collects what comes back. `ended` says how the exchange finished:
 * "close" when the server closed the connection, "timeout" when it went quiet for 1 second.
 */
export function rawExchange(port, text, { from = THIS_MACHINE } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: THIS_MACHINE, localAddress: from }, () => socket.write(text));
    let received = '';
    let done = false;
    const finish = (ended) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ text: received, ended });
    };
    socket.setTimeout(1000, () => finish('timeout'));
    socket.on('data', (chunk) => (received += chunk));
    socket.on('close', () => finish('close'));
    socket.on('error', () => finish('close'));
  });
}

/** A WebSocket upgrade request as a browser on this page would send it. */
export function upgradeRequest(port, { path = '/ws', host = `${THIS_MACHINE}:${port}`, origin = `http://${host}`, extraHeaders = [] } = {}) {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    ...(origin === null ? [] : [`Origin: ${origin}`]),
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Protocol: tty',
    ...extraHeaders,
    '',
    '',
  ].join('\r\n');
}
