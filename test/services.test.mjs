// Checks that the two systemd service files agree with each other and with the gatekeeper.
// A mismatch here would only show up after a restart or reboot, as a terminal that never loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers.mjs';

/** The settings in a unit file, as name to list of values (a setting can appear more than once). */
async function readUnit(name) {
  const text = await readFile(join(REPO_ROOT, 'systemd', name), 'utf8');
  const settings = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Za-z]+)=(.*)$/);
    if (match) (settings[match[1]] ??= []).push(match[2]);
  }
  return settings;
}

const gatekeeper = await readUnit('web-terminal.service');
const ttyd = await readUnit('web-terminal-ttyd.service');

function environment(unit) {
  return Object.fromEntries((unit.Environment ?? []).map((entry) => entry.split(/=(.*)/s).slice(0, 2)));
}

function ttydArgument(flag) {
  const args = ttyd.ExecStart[0].split(/\s+/);
  return args[args.indexOf(flag) + 1];
}

test('the gatekeeper looks for ttyd at the socket ttyd creates', () => {
  const socket = ttydArgument('--interface');
  assert.equal(environment(gatekeeper).TTYD_SOCKET, socket);
  assert.ok(socket.startsWith(`%t/${ttyd.RuntimeDirectory[0]}/`), 'the socket is inside the private folder systemd creates');
  assert.equal(ttyd.RuntimeDirectoryMode[0], '0700', 'only your user can open that folder');
});

test('ttyd only accepts connections from this page, with a limit on sessions', () => {
  const command = ttyd.ExecStart[0];
  assert.match(command, /--check-origin/);
  assert.match(command, /--writable/);
  assert.ok(Number(ttydArgument('--max-clients')) > 0);
});

test('every terminal session logs in through the SSH server, so it needs your password', () => {
  assert.match(ttyd.ExecStart[0], / ssh .*%u@localhost$/);
});

test('the gatekeeper gets its secrets from Bitwarden through bws run', () => {
  assert.match(gatekeeper.ExecStart[0], /\/bws run -- /);
  assert.match(gatekeeper.EnvironmentFile[0], /^%h\/\.config\/web-terminal\/bws\.env$/, 'the token file is outside the repo');
});

test('the gatekeeper runs as the compiled program from this repo, without Node', () => {
  assert.match(gatekeeper.ExecStart[0], /-- @PROJECT_DIR@\/gatekeeper\/target\/release\/gatekeeper$/);
  assert.equal(gatekeeper.WorkingDirectory[0], '@PROJECT_DIR@', 'it serves the page from its working directory; install.sh fills the folder in');
  assert.doesNotMatch(gatekeeper.ExecStart[0], /node|nvm/);
});

test('a configuration error stops the gatekeeper instead of restarting it forever', async () => {
  const source = await readFile(join(REPO_ROOT, 'gatekeeper', 'src', 'main.rs'), 'utf8');
  const exitCode = source.match(/const EXIT_CONFIG_ERROR: u8 = (\d+);/)[1];
  assert.equal(gatekeeper.RestartPreventExitStatus[0], exitCode);
  assert.equal(gatekeeper.Restart[0], 'always', 'other failures, such as Tailscale not up yet, are retried');
});

test('both services start at boot and run sandboxed', () => {
  for (const unit of [gatekeeper, ttyd]) {
    assert.equal(unit.WantedBy[0], 'default.target');
    assert.equal(unit.NoNewPrivileges[0], 'yes');
    assert.ok(unit.TasksMax && unit.MemoryMax, 'process and memory limits');
  }
  assert.equal(gatekeeper.MemoryDenyWriteExecute[0], 'yes', 'possible now that no JavaScript engine runs in it');
});
