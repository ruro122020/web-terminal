// The bytes each extra-keys bar key sends to the terminal. Kept free of browser and
// xterm.js objects so the tests can run these functions directly in Node.

const ESC = '\x1b';

const FIXED_SEQUENCES = {
  escape: ESC,
  tab: '\t',
  shiftTab: `${ESC}[Z`,
};

const ARROW_LETTERS = { up: 'A', down: 'B', right: 'C', left: 'D' };

/**
 * The bytes for one bar key. Programs like Claude Code's menus switch the arrows to
 * "application mode", which uses different codes, so the caller passes the current mode.
 */
export function keySequence(key, applicationCursorKeys) {
  if (Object.hasOwn(FIXED_SEQUENCES, key)) return FIXED_SEQUENCES[key];
  if (Object.hasOwn(ARROW_LETTERS, key)) {
    const letter = ARROW_LETTERS[key];
    return applicationCursorKeys ? `${ESC}O${letter}` : `${ESC}[${letter}`;
  }
  throw new Error(`Unknown key: ${key}`);
}

/**
 * True when `data` is one character the person typed. xterm.js also sends multi-character
 * sequences on its own, such as mouse clicks inside tmux; those must not use up a held Ctrl.
 */
export function isSingleKeystroke(data) {
  return [...data].length === 1;
}

/**
 * Ctrl plus a key, as the terminal byte for it: Ctrl+C is byte 3. Only ASCII letters and
 * the symbols @ [ \ ] ^ _ have a Ctrl form; everything else, including letters from other
 * alphabets, is returned unchanged.
 */
export function applyCtrl(data) {
  if (data.length !== 1) return data;
  const code = data.charCodeAt(0);
  if (code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60); // a to z
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40); // @, A to Z, [ \ ] ^ _
  return data;
}
