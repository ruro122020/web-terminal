// Opens the real page in a phone-sized touch browser, through the real gatekeeper, with a
// real ttyd behind it. Most sessions run `cat -vT`, which prints invisible key codes as
// visible text (Escape shows as ^[, Tab as ^I), so the tests can read exactly which bytes
// each key sent.
//
// Needs ttyd installed and Playwright's headless Chrome downloaded; see the README.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, devices } from 'playwright';
import { THIS_MACHINE, removeTempDirs, startGatekeeper, tempSocketPath } from '../helpers.mjs';

// One ttyd and gatekeeper per kind of session the tests need.
const SESSIONS = {
  // 500 lines to scroll through, then echo whatever is typed.
  normal: 'seq 1 500; exec cat -vT',
  // A program that switched the arrows to application mode, as Claude Code's menus do.
  applicationArrows: 'printf "\\033[?1h"; exec cat -vT',
  // A full-screen program (like less or vim), which has no scrollback.
  fullScreen: 'printf "\\033[?1049h"; exec cat -vT',
  // A program that asks for mouse and wheel events without going full-screen.
  mouseOnly: 'printf "\\033[?1000h\\033[?1006h"; seq 1 500; exec cat -vT',
  // A full-screen program that asks for mouse and wheel events, like Claude Code's full-screen mode.
  fullScreenWithMouse: 'printf "\\033[?1049h\\033[?1000h\\033[?1006h"; exec cat -vT',
  // Ends by itself a few seconds after starting, like a connection that drops.
  endsSoon: 'seq 1 500; sleep 3',
  // Prints the terminal size it was given, and again whenever it changes.
  size: 'trap "stty size" WINCH; stty size; while :; do sleep 0.1; done',
};

const running = [];
const urls = {};
let browser;

async function cleanUp() {
  await browser?.close();
  for (const { ttyd, gatekeeper } of running.splice(0)) {
    ttyd.kill();
    await gatekeeper.stop();
  }
  await removeTempDirs();
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await access(path);
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`ttyd did not create ${path}`);
}

before(async () => {
  // Interrupting the run (Ctrl+C) must not leave ttyd or temporary folders behind.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => cleanUp().finally(() => process.exit(130)));
  }
  for (const [name, command] of Object.entries(SESSIONS)) {
    const socketPath = await tempSocketPath();
    // The same origin check as production, so a proxy change that breaks it fails here too.
    const ttyd = spawn('ttyd', ['--writable', '--check-origin', '--interface', socketPath, 'sh', '-c', command], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    ttyd.on('error', (error) => {
      throw new Error(`could not start ttyd (is it installed?): ${error.message}`);
    });
    await waitForFile(socketPath);
    const gatekeeper = startGatekeeper({ LISTEN_HOST: THIS_MACHINE, ALLOWED_ADDRESSES: THIS_MACHINE, TTYD_SOCKET: socketPath });
    running.push({ ttyd, gatekeeper });
    urls[name] = `http://${THIS_MACHINE}:${await gatekeeper.ready}/`;
  }
  browser = await chromium.launch();
});

after(cleanUp);

/** A fresh phone-sized browser tab with its own terminal session, once `ready` text has arrived. */
async function openTerminal(t, session = 'normal', ready = '500') {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no errors on the page'));
  await page.goto(urls[session]);
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.length > 0);
  if (ready) await waitForScreen(page, ready);
  const touchscreen = await context.newCDPSession(page);
  return { page, touchscreen };
}

const screenText = (page) => page.evaluate(() => document.querySelector('.xterm-rows').textContent);

const waitForScreen = (page, text) =>
  page.waitForFunction((t) => document.querySelector('.xterm-rows').textContent.includes(t), text);

/** Waits until `text` appears on screen at least `count` times. */
const waitForCount = (page, text, count) =>
  page.waitForFunction(([t, n]) => document.querySelector('.xterm-rows').textContent.split(t).length - 1 >= n, [text, count]);

const firstVisibleLine = async (page) =>
  Number(await page.evaluate(() => document.querySelector('.xterm-rows > div')?.textContent.trim()));

const terminalHasFocus = (page) =>
  page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false);

/** Waits until the view stops moving, so a glide has finished. */
async function waitForStill(page) {
  let previous = await firstVisibleLine(page);
  for (;;) {
    await sleep(250);
    const current = await firstVisibleLine(page);
    if (current === previous) return current;
    previous = current;
  }
}

function touch(touchscreen, type, x, y) {
  return touchscreen.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
}

/** Drags one finger from one height to another. With `pauseMs`, the finger rests before lifting. */
async function drag(touchscreen, fromY, toY, { pauseMs = 0 } = {}) {
  const step = fromY < toY ? 20 : -20;
  await touch(touchscreen, 'touchStart', 190, fromY);
  for (let y = fromY + step; step > 0 ? y <= toY : y >= toY; y += step) await touch(touchscreen, 'touchMove', 190, y);
  if (pauseMs) await sleep(pauseMs);
  await touch(touchscreen, 'touchEnd');
}

/** Types a unique marker, taps one bar key, presses Enter, and returns what `cat -vT` printed back. */
async function sendBarKey(page, key, marker) {
  await page.tap('#terminal');
  await page.keyboard.type(marker);
  await page.tap(`#keys [data-key="${key}"]`);
  assert.ok(await terminalHasFocus(page), `tapping ${key} keeps the keyboard open`);
  await page.keyboard.press('Enter');
  await waitForCount(page, marker, 2); // the typed echo, then cat's copy
  return screenText(page);
}

// --- Scrolling ---

test('dragging a finger scrolls back through earlier output, and forward again', async (t) => {
  const { page, touchscreen } = await openTerminal(t);
  const atBottom = await firstVisibleLine(page);
  await drag(touchscreen, 150, 600);
  const back = await waitForStill(page);
  assert.ok(back < atBottom - 20, `scrolled back from line ${atBottom} to ${back}`);
  await drag(touchscreen, 600, 100);
  assert.equal(await waitForStill(page), atBottom);
});

test('the earliest line is still there to scroll back to', async (t) => {
  const { page, touchscreen } = await openTerminal(t);
  for (let i = 0; i < 25 && (await firstVisibleLine(page)) !== 1; i++) {
    await drag(touchscreen, 100, 650, { pauseMs: 150 });
  }
  assert.equal(await firstVisibleLine(page), 1);
});

test('a quick flick keeps gliding after the finger lifts', async (t) => {
  const { page, touchscreen } = await openTerminal(t);
  await drag(touchscreen, 150, 450);
  const atLift = await firstVisibleLine(page);
  const settled = await waitForStill(page);
  assert.ok(settled < atLift, `glided from line ${atLift} to ${settled}`);
});

test('resting the finger before lifting stops without a glide', async (t) => {
  const { page, touchscreen } = await openTerminal(t);
  await drag(touchscreen, 150, 450, { pauseMs: 200 });
  const atLift = await firstVisibleLine(page);
  assert.equal(await waitForStill(page), atLift);
});

test('in a program that asked for the mouse, dragging sends it wheel events', async (t) => {
  const { page, touchscreen } = await openTerminal(t, 'fullScreenWithMouse', null);
  await drag(touchscreen, 300, 500, { pauseMs: 150 }); // finger down: scroll the program up
  await waitForScreen(page, '^[[<64;'); // wheel up, in the mouse format the program asked for
  await drag(touchscreen, 500, 300, { pauseMs: 150 }); // finger up: scroll down
  await waitForScreen(page, '^[[<65;'); // wheel down
});

test('a program that asked for the mouse gets wheel events even without going full-screen', async (t) => {
  const { page, touchscreen } = await openTerminal(t, 'mouseOnly');
  const before = await firstVisibleLine(page);
  await drag(touchscreen, 300, 500, { pauseMs: 150 });
  await waitForScreen(page, '^[[<64;');
  // The echoed report adds lines at the bottom; scrolling back would move the view below `before`.
  assert.ok(await firstVisibleLine(page) >= before, 'the program scrolls, not the terminal');
});

test('in a full-screen program, dragging sends arrow keys instead of scrolling', async (t) => {
  const { page, touchscreen } = await openTerminal(t, 'fullScreen', null);
  await drag(touchscreen, 500, 300, { pauseMs: 150 }); // finger up: move down in the program
  await waitForScreen(page, '^[[B');
  await drag(touchscreen, 300, 500, { pauseMs: 150 }); // finger down: move up
  await waitForScreen(page, '^[[A');
});

// --- Keyboard and key bar ---

test('a tap on the terminal gives it keyboard focus', async (t) => {
  const { page } = await openTerminal(t);
  await page.tap('#terminal');
  assert.ok(await terminalHasFocus(page));
});

test('every bar key sends its code and keeps the keyboard open', async (t) => {
  const { page } = await openTerminal(t);
  const expected = {
    escape: '^[',
    tab: '^I',
    shiftTab: '^[[Z',
    up: '^[[A',
    down: '^[[B',
    right: '^[[C',
    left: '^[[D',
  };
  for (const [key, shown] of Object.entries(expected)) {
    const marker = `k${key}`;
    assert.ok((await sendBarKey(page, key, marker)).includes(`${marker}${shown}`), `${key} shows as ${shown}`);
  }
});

test('arrows send application-mode codes when the program asked for them', async (t) => {
  const { page } = await openTerminal(t, 'applicationArrows', null);
  assert.ok((await sendBarKey(page, 'up', 'app1')).includes('app1^[OA'));
});

test('holding an arrow repeats it', async (t) => {
  const { page, touchscreen } = await openTerminal(t);
  await page.tap('#terminal');
  await page.keyboard.type('hold1');
  const box = await page.locator('#keys [data-key="left"]').boundingBox();
  await touch(touchscreen, 'touchStart', box.x + box.width / 2, box.y + box.height / 2);
  await sleep(800);
  await touch(touchscreen, 'touchEnd');
  await page.keyboard.press('Enter');
  await waitForCount(page, 'hold1', 2);
  const repeats = (await screenText(page)).split('hold1')[2].split('^[[D').length - 1;
  assert.ok(repeats >= 4, `held for 0.8 s sent ${repeats} presses`);
});

test('Ctrl applies to the next typed key only, then turns itself off', async (t) => {
  const { page } = await openTerminal(t);
  const ctrl = page.locator('#keys [data-key="ctrl"]');
  await page.tap('#terminal');
  await page.keyboard.type('ctl1');
  await ctrl.tap();
  assert.equal(await ctrl.getAttribute('aria-pressed'), 'true', 'Ctrl shows as held');
  assert.ok(await terminalHasFocus(page), 'tapping Ctrl keeps the keyboard open');
  await page.keyboard.type('ab'); // Ctrl+A, then a plain b
  assert.equal(await ctrl.getAttribute('aria-pressed'), 'false', 'Ctrl released after one key');
  await page.keyboard.press('Enter');
  await waitForCount(page, 'ctl1', 2);
  assert.match(await screenText(page), /ctl1\^Ab/);
});

test('Ctrl stays held through text that is not a single keystroke', async (t) => {
  const { page } = await openTerminal(t);
  const ctrl = page.locator('#keys [data-key="ctrl"]');
  await page.tap('#terminal');
  await ctrl.tap();
  await page.keyboard.insertText('xyz'); // like a paste or an autocorrect replacement
  assert.equal(await ctrl.getAttribute('aria-pressed'), 'true');
});

// --- Size ---

test('the terminal tells the program its size, and its new size after a change', async (t) => {
  const { page } = await openTerminal(t, 'size', null);
  // The sizes `stty size` printed ("rows columns"), and how many rows the page shows now.
  const reported = () => page.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows > div')]
      .map((row) => row.textContent.trim())
      .filter((line) => /^\d+ \d+$/.test(line))
      .map((line) => Number(line.split(' ')[0])));
  const shownRows = () => page.evaluate(() => document.querySelectorAll('.xterm-rows > div').length);

  await page.waitForFunction(() => /\d+ \d+/.test(document.querySelector('.xterm-rows').textContent));
  assert.equal((await reported()).at(-1), await shownRows(), 'the program is told the size the page shows');

  await page.setViewportSize({ width: 390, height: 400 }); // like the iPhone keyboard opening
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.xterm-rows > div')].filter((row) => /^\d+ \d+$/.test(row.textContent.trim())).length >= 2);
  const sizes = await reported();
  assert.ok(sizes.at(-1) < sizes[0], `rows went from ${sizes[0]} to ${sizes.at(-1)}`);
  assert.equal(sizes.at(-1), await shownRows(), 'the program is told the new size');
});

test('turning the phone sideways re-wraps the terminal to the wider screen', async (t) => {
  const { page } = await openTerminal(t, 'size', null);
  // The column counts `stty size` printed ("rows columns").
  const reportedColumns = () => page.evaluate(() =>
    [...document.querySelectorAll('.xterm-rows > div')]
      .map((row) => row.textContent.trim())
      .filter((line) => /^\d+ \d+$/.test(line))
      .map((line) => Number(line.split(' ')[1])));
  await page.waitForFunction(() => /\d+ \d+/.test(document.querySelector('.xterm-rows').textContent));
  const [portrait] = await reportedColumns();

  await page.setViewportSize({ width: 844, height: 390 }); // an iPhone 13 held sideways
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.xterm-rows > div')].filter((row) => /^\d+ \d+$/.test(row.textContent.trim())).length >= 2);
  const landscape = (await reportedColumns()).at(-1);
  assert.ok(landscape > portrait * 1.5, `columns went from ${portrait} to ${landscape}`);
});

test('the key bar stays at the bottom of the visible area, below the terminal', async (t) => {
  const { page } = await openTerminal(t);
  for (const height of [664, 400]) { // the full screen, then the space left when the keyboard opens
    await page.setViewportSize({ width: 390, height });
    await page.waitForFunction((h) => Math.round(document.querySelector('#keys').getBoundingClientRect().bottom) === h, height);
    const keys = await page.locator('#keys').boundingBox();
    const terminal = await page.locator('#terminal').boundingBox();
    assert.ok(terminal.y + terminal.height <= keys.y + 1, `terminal ends above the key bar at height ${height}`);
  }
});

// --- Disconnecting ---

test('after a disconnect, the reconnect button is reachable and starts a new session', async (t) => {
  const { page } = await openTerminal(t, 'endsSoon');
  const ctrl = page.locator('#keys [data-key="ctrl"]');
  await page.tap('#terminal');
  await ctrl.tap(); // held when the session ends
  await waitForScreen(page, '[Disconnected]');

  const button = page.locator('#reconnect');
  assert.ok(await button.isVisible(), 'reconnect button shown');
  assert.ok(!(await terminalHasFocus(page)), 'keyboard closed so it cannot cover the button');
  assert.equal(await ctrl.getAttribute('aria-pressed'), 'false', 'Ctrl reset');
  assert.equal(await ctrl.getAttribute('aria-disabled'), 'true', 'keys marked unavailable');
  const buttonBox = await button.boundingBox();
  const keysBox = await page.locator('#keys').boundingBox();
  assert.ok(buttonBox.y + buttonBox.height <= keysBox.y, 'button sits above the key bar, not on it');

  await button.tap();
  // The new session prints its 500 lines again.
  await page.waitForFunction(() => {
    const text = document.querySelector('.xterm-rows').textContent;
    return !text.includes('[Disconnected]') && text.includes('500');
  });
  assert.ok(!(await button.isVisible()), 'button hidden again');
  assert.equal(await ctrl.getAttribute('aria-disabled'), 'false', 'keys available again');
});

test('coming back to the page after a disconnect reconnects by itself', async (t) => {
  const { page } = await openTerminal(t, 'endsSoon');
  await waitForScreen(page, '[Disconnected]');
  // What iOS reports when you switch back to the browser from another app.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => {
    const text = document.querySelector('.xterm-rows').textContent;
    return !text.includes('[Disconnected]') && text.includes('500');
  });
  assert.ok(!(await page.locator('#reconnect').isVisible()), 'no button needed');
});
