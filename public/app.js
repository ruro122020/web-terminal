import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { applyCtrl, isSingleKeystroke, keySequence } from '/keys.js';

// ttyd's WebSocket protocol: every message starts with one ASCII byte saying what it is.
const CLIENT_INPUT = '0';
const CLIENT_RESIZE = '1';
const SERVER_OUTPUT = '0'.charCodeAt(0);

const terminalElement = document.getElementById('terminal');
const reconnectButton = document.getElementById('reconnect');
const keyButtons = document.querySelectorAll('#keys button');
const ctrlButton = document.querySelector('[data-key="ctrl"]');

const encoder = new TextEncoder();
const terminal = new Terminal({
  scrollback: 10_000,
  fontSize: 14,
  fontFamily: 'Menlo, monospace',
  cursorBlink: true,
  theme: { background: '#000000' },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(terminalElement);

// --- Connection to ttyd ---

let socket;

function send(type, payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(type + payload));
}

function setConnected(connected) {
  document.body.classList.toggle('disconnected', !connected);
  reconnectButton.hidden = connected;
  for (const button of keyButtons) button.setAttribute('aria-disabled', String(!connected));
}

function connect() {
  setConnected(true);
  socket = new WebSocket(`ws://${location.host}/ws`, ['tty']);
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    socket.send(encoder.encode(JSON.stringify({ AuthToken: '', columns: terminal.cols, rows: terminal.rows })));
    terminal.focus();
  };
  socket.onmessage = (event) => {
    const bytes = new Uint8Array(event.data);
    if (bytes[0] === SERVER_OUTPUT) terminal.write(bytes.subarray(1));
  };
  socket.onclose = () => {
    terminal.write('\r\n[Disconnected]\r\n');
    setCtrlHeld(false);
    setConnected(false);
    // Closing the keyboard reveals the reconnect button, which it would otherwise cover.
    terminal.blur();
  };
}

reconnectButton.addEventListener('click', connect);

// iOS closes the connection while the app is in the background, so reconnect on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && socket.readyState === WebSocket.CLOSED) connect();
});

// --- Extra keys the iPhone keyboard doesn't have ---

let ctrlHeld = false;

function setCtrlHeld(held) {
  ctrlHeld = held;
  ctrlButton.setAttribute('aria-pressed', String(held));
}

terminal.onData((data) => {
  // A held Ctrl applies to the next key typed, not to sequences xterm.js generates itself.
  if (ctrlHeld && isSingleKeystroke(data)) {
    setCtrlHeld(false);
    data = applyCtrl(data);
  }
  send(CLIENT_INPUT, data);
});

function pressKey(key) {
  if (document.body.classList.contains('disconnected')) return;
  if (key === 'ctrl') setCtrlHeld(!ctrlHeld);
  else send(CLIENT_INPUT, keySequence(key, terminal.modes.applicationCursorKeysMode));
}

// Holding an arrow repeats it, like a physical keyboard.
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;
const REPEATING_KEYS = new Set(['up', 'down', 'left', 'right']);
let repeatTimer = 0;

function stopRepeat() {
  clearTimeout(repeatTimer);
  clearInterval(repeatTimer);
}

for (const button of keyButtons) {
  const key = button.dataset.key;
  // Acting on pointerdown and cancelling the default stops the button from taking focus,
  // which would close the iPhone keyboard.
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    pressKey(key);
    if (REPEATING_KEYS.has(key)) {
      stopRepeat();
      repeatTimer = setTimeout(() => {
        repeatTimer = setInterval(() => pressKey(key), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, stopRepeat);
  // Assistive input such as Switch Control or a hardware keyboard activates buttons with a
  // click and no pointer press; detail 0 means the click did not come from a pointer.
  button.addEventListener('click', (event) => {
    if (event.detail === 0) pressKey(key);
  });
  button.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false });
}

// --- One-finger scrolling ---
// xterm.js 6 has no touch scrolling, only the mouse wheel, so one-finger drags are turned into
// line scrolls here. At a shell prompt they move through the scrollback. When a program has
// asked for mouse events (such as Claude Code's full-screen mode) or is full-screen (such as
// less), the drag becomes a wheel event and xterm.js turns it into what that program expects:
// wheel reports, or arrow keys. A tap (no movement) still reaches xterm.js and opens the keyboard.

const GLIDE_FRICTION = 0.95; // per frame; lower stops sooner
const GLIDE_MAX_PAUSE_MS = 80; // a finger held still longer than this before lifting does not glide
let touchY = null;
let lastMoveTime = 0;
let leftoverPixels = 0;
let velocity = 0; // pixels per frame, for the glide after the finger lifts
let glideFrame = 0;

function lineHeight() {
  return terminal.element.querySelector('.xterm-screen').clientHeight / terminal.rows;
}

function scrollByPixels(pixels) {
  leftoverPixels += pixels;
  const lines = Math.trunc(leftoverPixels / lineHeight());
  if (lines === 0) return;
  leftoverPixels -= lines * lineHeight();
  if (programHandlesScrolling()) sendWheel(lines);
  else terminal.scrollLines(lines);
}

function programHandlesScrolling() {
  return terminal.modes.mouseTrackingMode !== 'none' || terminal.buffer.active.type === 'alternate';
}

// xterm.js's scrollback ignores wheel events created by a page (it reads a measurement only
// real wheels carry), but its routing to programs accepts them. That is why the scrollback
// is moved with scrollLines above and only programs get wheel events.
function sendWheel(lines) {
  const screen = terminal.element.querySelector('.xterm-screen');
  const { left, top, width, height } = screen.getBoundingClientRect();
  screen.dispatchEvent(new WheelEvent('wheel', {
    deltaY: lines,
    deltaMode: WheelEvent.DOM_DELTA_LINE,
    clientX: left + width / 2, // where a mouse would be, for programs that use the position
    clientY: top + height / 2,
    bubbles: true,
    cancelable: true,
  }));
}

function glide() {
  if (Math.abs(velocity) < 0.5) return;
  scrollByPixels(velocity);
  velocity *= GLIDE_FRICTION;
  glideFrame = requestAnimationFrame(glide);
}

terminalElement.addEventListener('touchstart', (event) => {
  cancelAnimationFrame(glideFrame);
  velocity = 0;
  leftoverPixels = 0;
  touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
}, { passive: true });

terminalElement.addEventListener('touchmove', (event) => {
  if (touchY === null || event.touches.length !== 1) return;
  const y = event.touches[0].clientY;
  const dragged = touchY - y; // finger moving up scrolls toward newer lines
  touchY = y;
  velocity = dragged;
  lastMoveTime = performance.now();
  scrollByPixels(dragged);
  event.preventDefault(); // stop iOS from also bouncing the page
}, { passive: false });

terminalElement.addEventListener('touchend', () => {
  touchY = null;
  const paused = performance.now() - lastMoveTime > GLIDE_MAX_PAUSE_MS;
  if (paused) return;
  glideFrame = requestAnimationFrame(glide);
});

// --- Sizing ---

// The iPhone keyboard covers the page instead of resizing it. visualViewport reports the area
// still visible, so size the page to that and undo the scroll iOS adds when the keyboard opens.
const KEYBOARD_MIN_HEIGHT = 100;

function fitToVisibleArea() {
  const viewport = window.visualViewport;
  if (viewport.scale !== 1) return; // zoomed in: the visible area is not the page size
  document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
  document.body.classList.toggle('keyboard-open', viewport.height < window.innerHeight - KEYBOARD_MIN_HEIGHT);
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', fitToVisibleArea);
window.visualViewport?.addEventListener('scroll', fitToVisibleArea);

terminal.onResize(({ cols, rows }) => send(CLIENT_RESIZE, JSON.stringify({ columns: cols, rows })));
// Also runs once right away, which gives the terminal its first size.
new ResizeObserver(() => fit.fit()).observe(terminalElement);

connect();
