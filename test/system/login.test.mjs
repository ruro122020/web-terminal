// Runs the exact ttyd command from systemd/web-terminal-ttyd.service, behind the real gatekeeper,
// and checks that a terminal session reaches this computer's SSH password prompt. It stops at the
// prompt and never types a password.
//
// Needs ttyd installed, the SSH server running (README step 1) and systemd; see the README.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT, THIS_MACHINE, removeTempDirs, renderUnits, startGatekeeper, tempSocketPath, waitForFile } from '../helpers.mjs';

after(removeTempDirs);

/** The service's ttyd command, with systemd's placeholders filled in for this test. */
async function ttydCommand(socketPath) {
  const unit = await readFile(join(REPO_ROOT, 'systemd', 'web-terminal-ttyd.service'), 'utf8');
  const execStart = unit.match(/^ExecStart=(.*)$/m)[1];
  const [program, ...args] = execStart
    .replace(/%t\/web-terminal\/ttyd\.sock/, socketPath)
    .replaceAll('%u', userInfo().username)
    .split(/\s+/);
  return { program, args };
}

test('both service files pass systemd\'s own checks once the project folder is filled in', async () => {
  const dir = await renderUnits();
  const units = ['web-terminal.service', 'web-terminal-ttyd.service'].map((name) => join(dir, name));
  const { stderr } = await promisify(execFile)('systemd-analyze', ['--user', 'verify', ...units]);
  const problems = stderr.split('\n').filter((line) => line.includes('web-terminal'));
  assert.deepEqual(problems, []);
});

test('a terminal session through the gatekeeper reaches the SSH password prompt', async (t) => {
  const socketPath = await tempSocketPath();
  const { program, args } = await ttydCommand(socketPath);
  const ttyd = spawn(program, args, { stdio: 'ignore' });
  t.after(() => ttyd.kill());
  await waitForFile(socketPath);

  const gatekeeper = startGatekeeper({ LISTEN_HOST: THIS_MACHINE, ALLOWED_ADDRESSES: THIS_MACHINE, TTYD_SOCKET: socketPath });
  t.after(() => gatekeeper.stop());
  const page = `http://${THIS_MACHINE}:${await gatekeeper.ready}`;

  // The same connection the page opens, including the Origin header a browser sends.
  const socket = new WebSocket(`${page.replace('http', 'ws')}/ws`, { protocols: ['tty'], headers: { Origin: page } });
  socket.binaryType = 'arraybuffer';
  t.after(() => socket.close());
  let output = '';
  const prompt = new Promise((resolve, reject) => {
    socket.onopen = () => socket.send(new TextEncoder().encode(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 })));
    socket.onmessage = (event) => {
      const bytes = new Uint8Array(event.data);
      if (bytes[0] !== '0'.charCodeAt(0)) return; // only terminal output
      output += new TextDecoder().decode(bytes.subarray(1));
      if (/password:\s*$/.test(output)) resolve();
    };
    socket.onerror = () => reject(new Error(`connection failed; output so far: ${JSON.stringify(output)}`));
    socket.onclose = () => reject(new Error(`connection closed; output so far: ${JSON.stringify(output)}`));
    setTimeout(() => reject(new Error(`no password prompt within 10 s; output so far: ${JSON.stringify(output)}`)), 10_000);
  });
  await prompt;
  assert.match(output, new RegExp(`${userInfo().username}@localhost's password:`));
});
