// Checks that systemd/install.sh writes service files for wherever this project folder is.
// A wrong path here would only show up after a reboot or a move, as a service that never starts.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT, removeTempDirs, renderUnits, tempDir } from './helpers.mjs';

after(removeTempDirs);

const UNITS = ['web-terminal.service', 'web-terminal-ttyd.service'];

/**
 * A copy of systemd/ (templates and script) inside a fresh temp folder, for cases that must not touch the
 * repo's own files or need the project at a particular kind of path. Returns the copy's install.sh.
 */
async function copyOfSystemd(projectName) {
  const project = join(await tempDir(), projectName);
  await cp(join(REPO_ROOT, 'systemd'), join(project, 'systemd'), { recursive: true });
  return join(project, 'systemd', 'install.sh');
}

test('the installed services are the repo\'s files with this project folder filled in', async () => {
  const dir = await renderUnits();
  const folder = await realpath(REPO_ROOT); // the script writes the real path, without the trailing slash
  for (const unit of UNITS) {
    const template = await readFile(join(REPO_ROOT, 'systemd', unit), 'utf8');
    assert.equal(await readFile(join(dir, unit), 'utf8'), template.replaceAll('@PROJECT_DIR@', folder), unit);
  }
});

test('a link left by the old `systemctl --user link` setup is replaced, not written through', async () => {
  // Works on a copy, so a failure here can never damage the repo's own files.
  const script = await copyOfSystemd('project');
  const template = join(script, '..', 'web-terminal.service');
  const dir = join(script, '..', '..', 'units');
  await mkdir(dir);
  await symlink(template, join(dir, 'web-terminal.service'));

  await promisify(execFile)(script, ['--render-to', dir], { cwd: dir });

  assert.equal((await lstat(join(dir, 'web-terminal.service'))).isSymbolicLink(), false, 'a real file now');
  assert.match(await readFile(template, 'utf8'), /@PROJECT_DIR@/, 'the linked file is untouched');
});

test('a project path with a character that unit files give a meaning is refused, and nothing is written', async () => {
  // A space would split the ExecStart command; % would start a systemd specifier such as %h.
  for (const name of ['has space', 'has%percent']) {
    const script = await copyOfSystemd(name);
    const dir = join(script, '..', '..', 'units');
    await assert.rejects(
      promisify(execFile)(script, ['--render-to', dir], { cwd: await tempDir() }),
      (error) => error.code === 1 && /cannot carry as-is/.test(error.stderr),
      name,
    );
    await assert.rejects(access(dir), `${name}: no folder is created before the path is checked`);
  }
});

test('a destination that does not exist yet is created, as ~/.config/systemd/user may be on a fresh computer', async () => {
  const dir = join(await tempDir(), 'config', 'systemd', 'user');
  await promisify(execFile)(join(REPO_ROOT, 'systemd', 'install.sh'), ['--render-to', dir], { cwd: await tempDir() });
  for (const unit of UNITS) await access(join(dir, unit));
});

test('wrong arguments stop the script with the usage line before anything is written', async () => {
  const dir = join(await tempDir(), 'units');
  for (const args of [['--render-to'], ['--bogus', dir], ['--render-to', dir, 'extra']]) {
    await assert.rejects(
      promisify(execFile)(join(REPO_ROOT, 'systemd', 'install.sh'), args, { cwd: await tempDir() }),
      (error) => error.code === 2 && /^usage: /m.test(error.stderr),
      args.join(' '),
    );
  }
  await assert.rejects(access(dir), 'nothing was written');
});
