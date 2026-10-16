import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCtrl, isSingleKeystroke, keySequence } from '../public/keys.js';

test('Ctrl plus a letter sends that letter\'s control code', () => {
  assert.equal(applyCtrl('c'), '\x03'); // stop the running program
  assert.equal(applyCtrl('d'), '\x04'); // end of input, logs out of a shell
  assert.equal(applyCtrl('r'), '\x12'); // search earlier commands
  assert.equal(applyCtrl('C'), '\x03', 'capital letters give the same code');
});

test('Ctrl plus a symbol with a control form sends it', () => {
  assert.equal(applyCtrl('['), '\x1b', 'Ctrl+[ is Escape');
  assert.equal(applyCtrl('@'), '\x00');
  assert.equal(applyCtrl('_'), '\x1f');
});

test('Ctrl leaves keys without a control form unchanged', () => {
  assert.equal(applyCtrl('1'), '1');
  assert.equal(applyCtrl(' '), ' ');
  assert.equal(applyCtrl('ab'), 'ab', 'pasted or multi-character input passes through');
  assert.equal(applyCtrl(''), '');
});

test('Ctrl leaves letters from other alphabets unchanged', () => {
  // toUpperCase() would turn these into ASCII letters: ß to SS, ſ to S, ı to I.
  // Ctrl+S would freeze the screen and Ctrl+I is Tab, so they must pass through as typed.
  for (const letter of ['ß', 'ſ', 'ı', 'é', 'ñ', 'ж', '😀']) assert.equal(applyCtrl(letter), letter, letter);
});

test('one typed character counts as a keystroke; generated sequences do not', () => {
  for (const typed of ['a', 'Z', '1', '\x1b', 'é', '😀']) assert.ok(isSingleKeystroke(typed), JSON.stringify(typed));
  // A mouse click report inside tmux, a pasted word, and an autocorrected replacement.
  for (const generated of ['\x1b[M #!', 'hello', 'ab']) assert.ok(!isSingleKeystroke(generated), JSON.stringify(generated));
});

test('Esc, Tab and Shift+Tab send their fixed codes in either arrow mode', () => {
  for (const mode of [false, true]) {
    assert.equal(keySequence('escape', mode), '\x1b');
    assert.equal(keySequence('tab', mode), '\t');
    assert.equal(keySequence('shiftTab', mode), '\x1b[Z');
  }
});

test('arrows send normal-mode codes when the program has not asked otherwise', () => {
  assert.equal(keySequence('up', false), '\x1b[A');
  assert.equal(keySequence('down', false), '\x1b[B');
  assert.equal(keySequence('right', false), '\x1b[C');
  assert.equal(keySequence('left', false), '\x1b[D');
});

test('arrows send application-mode codes when the program asked for them', () => {
  assert.equal(keySequence('up', true), '\x1bOA');
  assert.equal(keySequence('down', true), '\x1bOB');
  assert.equal(keySequence('right', true), '\x1bOC');
  assert.equal(keySequence('left', true), '\x1bOD');
});

test('an unknown key name is an error, not silent garbage', () => {
  assert.throws(() => keySequence('pageUp', false), /Unknown key: pageUp/);
  assert.throws(() => keySequence('toString', false), /Unknown key/, 'built-in object properties are not keys');
});
