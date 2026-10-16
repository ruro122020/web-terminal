import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

// ttyd's WebSocket protocol: every message starts with one ASCII byte saying what it is.
const CLIENT_INPUT = '0';
const CLIENT_RESIZE = '1';
const SERVER_OUTPUT = '0'.charCodeAt(0);

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
terminal.open(document.getElementById('terminal'));
fit.fit();

const reconnectButton = document.getElementById('reconnect');
let socket;

function send(type, payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(type + payload));
}

function connect() {
  reconnectButton.hidden = true;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${scheme}://${location.host}/ws`, ['tty']);
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
    reconnectButton.hidden = false;
  };
}

// Extra keys the iPhone keyboard doesn't have.
const ESC = '\x1b';
const KEY_SEQUENCES = {
  escape: () => ESC,
  tab: () => '\t',
  shiftTab: () => `${ESC}[Z`,
  // Programs like Claude Code's menus switch arrows to "application mode", which uses different codes.
  up: () => arrow('A'),
  down: () => arrow('B'),
  right: () => arrow('C'),
  left: () => arrow('D'),
};

function arrow(letter) {
  return terminal.modes.applicationCursorKeysMode ? `${ESC}O${letter}` : `${ESC}[${letter}`;
}

const ctrlButton = document.querySelector('[data-key="ctrl"]');
let ctrlHeld = false;

function setCtrlHeld(held) {
  ctrlHeld = held;
  ctrlButton.setAttribute('aria-pressed', String(held));
}

// Ctrl+letter is the letter's code with the top bits cleared: Ctrl+C is byte 3.
function applyCtrl(data) {
  const code = data.toUpperCase().charCodeAt(0);
  const hasControlForm = data.length === 1 && code >= 64 && code <= 95;
  return hasControlForm ? String.fromCharCode(code & 0x1f) : data;
}

terminal.onData((data) => {
  if (ctrlHeld) {
    setCtrlHeld(false);
    data = applyCtrl(data);
  }
  send(CLIENT_INPUT, data);
});

for (const button of document.querySelectorAll('#keys button')) {
  // Acting on pointerdown and cancelling the default stops the button from taking focus,
  // which would close the iPhone keyboard.
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const key = button.dataset.key;
    if (key === 'ctrl') setCtrlHeld(!ctrlHeld);
    else send(CLIENT_INPUT, KEY_SEQUENCES[key]());
  });
  button.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false });
}

// xterm.js 6 only scrolls with a mouse wheel, so one-finger drags are turned into line scrolls here.
// A tap (no movement) still reaches xterm.js and opens the keyboard.
const terminalElement = document.getElementById('terminal');
const GLIDE_FRICTION = 0.95; // per frame; lower stops sooner
let touchY = null;
let leftoverPixels = 0;
let velocity = 0; // pixels per frame, for the glide after the finger lifts
let glideFrame = 0;

function lineHeight() {
  return terminal.element.querySelector('.xterm-screen').clientHeight / terminal.rows;
}

function scrollByPixels(pixels) {
  leftoverPixels += pixels;
  const lines = Math.trunc(leftoverPixels / lineHeight());
  if (lines !== 0) {
    terminal.scrollLines(lines);
    leftoverPixels -= lines * lineHeight();
  }
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
  scrollByPixels(dragged);
  event.preventDefault(); // stop iOS from also bouncing the page
}, { passive: false });

terminalElement.addEventListener('touchend', () => {
  touchY = null;
  glideFrame = requestAnimationFrame(glide);
});

// The iPhone keyboard covers the page instead of resizing it. visualViewport reports the area
// still visible, so size the page to that and undo the scroll iOS adds when the keyboard opens.
function fitToVisibleArea() {
  document.documentElement.style.setProperty('--app-height', `${window.visualViewport.height}px`);
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', fitToVisibleArea);
window.visualViewport?.addEventListener('scroll', fitToVisibleArea);
terminal.onResize(({ cols, rows }) => send(CLIENT_RESIZE, JSON.stringify({ columns: cols, rows })));
new ResizeObserver(() => fit.fit()).observe(document.getElementById('terminal'));
reconnectButton.addEventListener('click', connect);

connect();
