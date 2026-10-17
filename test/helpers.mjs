// Shared by the service, system and browser tests. Uses only loopback addresses, never real ones.
// The gatekeeper's own tests are in Rust, in gatekeeper/tests.

import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const THIS_MACHINE = '127.0.0.1';

/** The compiled gatekeeper. `npm run build` creates it; the test scripts run that first. */
const GATEKEEPER = join(REPO_ROOT, 'gatekeeper', 'target', 'release', 'gatekeeper');

const tempDirs = [];

export async function tempSocketPath() {
  const dir = await mkdtemp(join(tmpdir(), 'web-terminal-test-'));
  tempDirs.push(dir);
  return join(dir, 'ttyd.sock');
}

export function removeTempDirs() {
  return Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** Runs the gatekeeper with only the given settings. `ready` resolves with its port once it is listening. */
export function startGatekeeper(env) {
  const child = spawn(GATEKEEPER, [], {
    cwd: REPO_ROOT, // it serves the page from its working directory
    env: { PATH: process.env.PATH, LISTEN_PORT: '0', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const ready = new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`could not start ${GATEKEEPER} (run \`npm run build\`): ${error.message}`)));
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
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.on('close', resolve);
      child.kill();
    }),
  };
}

/** Waits for ttyd to create its socket file. */
export async function waitForFile(path) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await access(path);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`ttyd did not create ${path}`);
}
