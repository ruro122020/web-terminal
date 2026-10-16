// Starts the real gatekeeper (server.mjs) on 127.0.0.1 with a fake ttyd behind it,
// then talks to it over real connections.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OTHER_DEVICE, REPO_ROOT, THIS_MACHINE,
  makeTempDir, rawExchange, removeTempDirs, request, startFakeTtyd, startGatekeeper, tempSocketPath, upgradeRequest, waitUntil,
} from './helpers.mjs';

after(removeTempDirs);

const EXIT_CONFIG_ERROR = 78;

const EXPECTED_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
  "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Starts a gatekeeper and fake ttyd, runs `test`, and always stops both. */
async function withGatekeeper({ allowed = THIS_MACHINE, ttydSocket, cwd, env = {} } = {}, run) {
  const ttyd = ttydSocket ? null : await startFakeTtyd();
  const gatekeeper = startGatekeeper(
    { LISTEN_HOST: THIS_MACHINE, ALLOWED_ADDRESSES: allowed, TTYD_SOCKET: ttydSocket ?? ttyd.socketPath, ...env },
    { cwd },
  );
  try {
    const port = await gatekeeper.ready;
    await run({ port, ttyd, gatekeeper });
    if (gatekeeper.child.exitCode !== null) {
      throw new Error(`gatekeeper crashed during the test: ${gatekeeper.output().stderr}`);
    }
  } finally {
    await gatekeeper.stop();
    await ttyd?.close();
  }
}

/** Opens a terminal connection through the gatekeeper and resolves once ttyd has answered. */
function openTerminal(port, { from = THIS_MACHINE } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: THIS_MACHINE, localAddress: from }, () => socket.write(upgradeRequest(port)));
    let received = '';
    const onData = (chunk) => {
      received += chunk;
      if (!received.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      if (received.startsWith('HTTP/1.1 101')) resolve(socket);
      else reject(new Error(`upgrade refused: ${received}`));
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

async function expectExit(env, code, message) {
  const gatekeeper = startGatekeeper(env);
  await assert.rejects(gatekeeper.ready, new RegExp(`exited with ${code}: [\\s\\S]*${message}`));
}

// --- Starting up ---

const VALID_ENV = { LISTEN_HOST: THIS_MACHINE, ALLOWED_ADDRESSES: THIS_MACHINE, TTYD_SOCKET: '/nonexistent.sock' };

test('stops with a configuration error when a setting is missing', async () => {
  for (const name of Object.keys(VALID_ENV)) {
    const env = { ...VALID_ENV };
    delete env[name];
    await expectExit(env, EXIT_CONFIG_ERROR, `Missing ${name}`);
  }
});

test('stops with a configuration error when settings are not IP addresses', async () => {
  await expectExit({ ...VALID_ENV, LISTEN_HOST: 'localhost' }, EXIT_CONFIG_ERROR, 'LISTEN_HOST must be an IP address');
  await expectExit({ ...VALID_ENV, ALLOWED_ADDRESSES: '127.0.0.1,my-phone' }, EXIT_CONFIG_ERROR, 'ALLOWED_ADDRESSES must be');
  await expectExit({ ...VALID_ENV, ALLOWED_ADDRESSES: ' , ' }, EXIT_CONFIG_ERROR, 'ALLOWED_ADDRESSES must be');
});

test('listens only on LISTEN_HOST, not on other addresses of this computer', async () => {
  await withGatekeeper({}, async ({ port }) => {
    const error = await new Promise((resolve) => {
      net.connect(port, OTHER_DEVICE).on('error', resolve).on('connect', () => resolve(null));
    });
    assert.equal(error?.code, 'ECONNREFUSED');
  });
});

// --- Which devices get in ---

test('the allowed device gets in and every other device is dropped without a reply', async () => {
  await withGatekeeper({}, async ({ port, ttyd, gatekeeper }) => {
    assert.equal((await request(port, '/')).status, 200, 'allowed device');

    const page = await rawExchange(port, `GET / HTTP/1.1\r\nHost: ${THIS_MACHINE}:${port}\r\n\r\n`, { from: OTHER_DEVICE });
    assert.deepEqual(page, { text: '', ended: 'close' }, 'page request from another device');

    const terminal = await rawExchange(port, upgradeRequest(port), { from: OTHER_DEVICE });
    assert.deepEqual(terminal, { text: '', ended: 'close' }, 'terminal request from another device');
    assert.equal(ttyd.connections.length, 0, 'nothing reached ttyd');

    await waitUntil(() => gatekeeper.output().stderr.includes(`Refused ${OTHER_DEVICE}`), 3000, 'the refusal to be logged');
  });
});

test('several devices can be allowed, with or without spaces after the commas', async () => {
  await withGatekeeper({ allowed: `${OTHER_DEVICE}, ${THIS_MACHINE} ,` }, async ({ port }) => {
    assert.equal((await request(port, '/')).status, 200);
    assert.equal((await request(port, '/', { from: OTHER_DEVICE })).status, 200);
  });
});

// --- Requests that use another site's name (DNS rebinding) ---

test('page requests addressed to any other host name are refused', async () => {
  await withGatekeeper({}, async ({ port }) => {
    for (const host of [`evil.example:${port}`, `${THIS_MACHINE}:1`, THIS_MACHINE]) {
      assert.equal((await request(port, '/', { headers: { Host: host } })).status, 421, host);
    }
  });
});

test('terminal connections need the exact Host and Origin of this page', async () => {
  await withGatekeeper({}, async ({ port, ttyd }) => {
    const pageHost = `${THIS_MACHINE}:${port}`;
    const attempts = {
      'rebinding: both headers name the attacker': { host: `evil.example:${port}`, origin: `http://evil.example:${port}` },
      'another site': { host: pageHost, origin: 'http://evil.example' },
      'no Origin': { host: pageHost, origin: null },
      'wrong port': { host: pageHost, origin: `http://${THIS_MACHINE}:1` },
      'wrong scheme': { host: pageHost, origin: `https://${pageHost}` },
    };
    for (const [name, headers] of Object.entries(attempts)) {
      const { text } = await rawExchange(port, upgradeRequest(port, headers));
      assert.match(text, /^HTTP\/1\.1 403/, name);
    }
    assert.equal(ttyd.connections.length, 0, 'nothing reached ttyd');
  });
});

// --- Page files ---

test('every page file is served with its exact contents, type and security headers', async () => {
  const expected = {
    '/': ['public/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
    '/keys.js': ['public/keys.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
    '/apple-touch-icon.png': ['public/apple-touch-icon.png', 'image/png'],
    '/manifest.webmanifest': ['public/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/vendor/xterm.mjs': ['node_modules/@xterm/xterm/lib/xterm.mjs', 'text/javascript; charset=utf-8'],
    '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
    '/vendor/addon-fit.mjs': ['node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'text/javascript; charset=utf-8'],
  };
  await withGatekeeper({}, async ({ port }) => {
    for (const [path, [file, type]] of Object.entries(expected)) {
      const response = await request(port, path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers['content-type'], type, path);
      assert.deepEqual(response.body, await readFile(join(REPO_ROOT, file)), `${path} serves ${file}`);
      assert.equal(response.headers['content-security-policy'], EXPECTED_CSP, path);
      assert.equal(response.headers['x-frame-options'], 'DENY', path);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(response.headers['cache-control'], 'no-store', path);
    }
    assert.equal((await request(port, '/?v=1')).status, 200, 'a query string does not change the file');
  });
});

test('anything else is 404 with the same security headers, including path tricks', async () => {
  await withGatekeeper({}, async ({ port }) => {
    for (const path of [
      '/server.mjs',
      '/../server.mjs',
      '/%2e%2e/server.mjs',
      '/public/app.js',
      '/node_modules/@xterm/xterm/package.json',
      '/vendor/../server.mjs',
      '//evil.example/',
      '/token',
    ]) {
      const response = await request(port, path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers['content-security-policy'], EXPECTED_CSP, path);
    }
  });
});

test('only GET is answered', async () => {
  await withGatekeeper({}, async ({ port }) => {
    assert.equal((await request(port, '/', { method: 'POST' })).status, 404);
    assert.equal((await request(port, '/', { method: 'PUT' })).status, 404);
  });
});

test('a page file that cannot be read gives 500 without stopping the gatekeeper', async () => {
  // A copy of the project without node_modules, as if `npm ci` was never run.
  const copy = await makeTempDir('web-terminal-copy-');
  await cp(join(REPO_ROOT, 'server.mjs'), join(copy, 'server.mjs'));
  await cp(join(REPO_ROOT, 'public'), join(copy, 'public'), { recursive: true });
  await withGatekeeper({ cwd: copy }, async ({ port, gatekeeper }) => {
    assert.equal((await request(port, '/vendor/xterm.mjs')).status, 500);
    await waitUntil(() => gatekeeper.output().stderr.includes('Could not read node_modules'), 3000, 'the error to be logged');
    assert.equal((await request(port, '/')).status, 200, 'still serving');
  });
});

// --- The terminal connection ---

test('/ws reaches ttyd as a clean request with only the headers ttyd needs', async () => {
  await withGatekeeper({}, async ({ port, ttyd }) => {
    const socket = await openTerminal(port);
    socket.destroy();
    await waitUntil(() => ttyd.connections.length === 1, 3000, 'ttyd to receive the connection');
    const forwarded = ttyd.connections[0].request;
    assert.match(forwarded, /^GET \/ws HTTP\/1\.1\r\n/);
    assert.match(forwarded, new RegExp(`\r\norigin: http://${THIS_MACHINE.replaceAll('.', '\\.')}:${port}\r\n`), 'ttyd checks Origin');
    assert.match(forwarded, /\r\nsec-websocket-protocol: tty\r\n/);

    const { text } = await rawExchange(port, upgradeRequest(port, { extraHeaders: ['X-Injected: yes', 'Cookie: a=b'] }));
    assert.match(text, /^HTTP\/1\.1 101/);
    await waitUntil(() => ttyd.connections.length === 2, 3000, 'the second connection');
    assert.doesNotMatch(ttyd.connections[1].request, /x-injected|cookie/i, 'other headers are not forwarded');
  });
});

test('the terminal connection carries data both ways and stays open', async () => {
  await withGatekeeper({}, async ({ port, ttyd }) => {
    const socket = await openTerminal(port);
    const echoed = new Promise((resolve) => socket.on('data', (chunk) => String(chunk).includes('ls -la') && resolve()));
    socket.write('ls -la\r');
    await echoed;
    assert.equal(ttyd.connections[0].received, 'ls -la\r');
    socket.destroy();
  });
});

test('closing the page closes the ttyd session, so no shell is left running', async () => {
  await withGatekeeper({}, async ({ port, ttyd }) => {
    const socket = await openTerminal(port);
    socket.end();
    await waitUntil(() => ttyd.connections[0]?.closed, 3000, 'the ttyd side to close');
  });
});

test('when ttyd ends the session, the page is disconnected', async () => {
  await withGatekeeper({}, async ({ port, ttyd }) => {
    const socket = await openTerminal(port);
    const closed = new Promise((resolve) => socket.on('close', resolve));
    await waitUntil(() => ttyd.connections.length === 1, 3000, 'the ttyd connection');
    ttyd.connections[0].socket.end();
    await closed;
  });
});

test('upgrade requests to any other path, or with a body, never reach ttyd', async () => {
  await withGatekeeper({}, async ({ port, ttyd }) => {
    for (const path of ['/', '/token', '/ws/../ws2', '//token/../ws']) {
      assert.match((await rawExchange(port, upgradeRequest(port, { path }))).text, /^HTTP\/1\.1 404/, path);
    }
    const withBody = await rawExchange(port, upgradeRequest(port, { extraHeaders: ['Content-Length: 5'] }) + 'hello');
    assert.match(withBody.text, /^HTTP\/1\.1 400/);
    assert.equal(ttyd.connections.length, 0);
  });
});

test('when ttyd is not running, the terminal connection is closed and the gatekeeper keeps going', async () => {
  const missingSocket = await tempSocketPath();
  await withGatekeeper({ ttydSocket: missingSocket }, async ({ port }) => {
    const response = await rawExchange(port, upgradeRequest(port));
    assert.equal(response.ended, 'close', 'closed, not left hanging');
    assert.doesNotMatch(response.text, /101/);
    assert.equal((await request(port, '/')).status, 200, 'still serving');
  });
});

// --- Staying up ---

test('malformed requests do not stop the gatekeeper', async () => {
  await withGatekeeper({}, async ({ port }) => {
    await rawExchange(port, `GET http://[ HTTP/1.1\r\nHost: ${THIS_MACHINE}:${port}\r\n\r\n`);
    await rawExchange(port, upgradeRequest(port, { path: 'http://[' }));
    assert.equal((await request(port, '/')).status, 200, 'still serving');
  });
});

test('clients that disconnect abruptly do not stop the gatekeeper', async () => {
  await withGatekeeper({}, async ({ port }) => {
    // An open terminal connection that is suddenly cut, as when a phone drops off Wi-Fi.
    (await openTerminal(port)).resetAndDestroy();
    // A refused device that cuts its connection while being dropped.
    const refused = net.connect({ port, host: THIS_MACHINE, localAddress: OTHER_DEVICE }, () => {
      refused.write(upgradeRequest(port));
      refused.resetAndDestroy();
    });
    refused.on('error', () => {});
    // Refused terminal requests that are cut the moment the refusal arrives. Several
    // attempts, because the crash this guards against depends on timing.
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => {
        const cut = net.connect(port, THIS_MACHINE, () => cut.write(upgradeRequest(port, { origin: 'http://evil.example' })));
        cut.once('data', () => {
          cut.resetAndDestroy();
          resolve();
        });
        cut.on('error', resolve);
        cut.on('close', resolve);
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await request(port, '/')).status, 200, 'still serving');
  });
});

test('connections are limited, and closed ones free their place', async () => {
  await withGatekeeper({ env: { MAX_CONNECTIONS: '2' } }, async ({ port }) => {
    const first = await openTerminal(port);
    const second = await openTerminal(port);
    const third = await rawExchange(port, upgradeRequest(port));
    assert.deepEqual(third, { text: '', ended: 'close' }, 'a third connection is dropped');

    first.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const replacement = await openTerminal(port);
    replacement.destroy();
    second.destroy();
  });
});
