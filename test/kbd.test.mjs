import assert from 'node:assert/strict';
import test from 'node:test';
import { keyToAction, textToAction } from '../web/src/lib/kbd.js';

const press = (key, modifiers = {}) => keyToAction({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...modifiers });

test('a printable character is typed, not pasted', () => {
  assert.deepEqual(press('a'), { kind: 'text', text: 'a' });
  assert.deepEqual(press('/'), { kind: 'text', text: '/' });
  assert.deepEqual(press(' '), { kind: 'text', text: ' ' });
  assert.deepEqual(press('A'), { kind: 'text', text: 'A' });
});

test('editing and navigation keys become herdr key names', () => {
  assert.deepEqual(press('Enter'), { kind: 'keys', keys: ['Enter'] });
  assert.deepEqual(press('Backspace'), { kind: 'keys', keys: ['Backspace'] });
  assert.deepEqual(press('Tab'), { kind: 'keys', keys: ['Tab'] });
  assert.deepEqual(press('Escape'), { kind: 'keys', keys: ['Escape'] });
  assert.deepEqual(press('ArrowUp'), { kind: 'keys', keys: ['Up'] });
  assert.deepEqual(press('ArrowDown'), { kind: 'keys', keys: ['Down'] });
  assert.deepEqual(press('ArrowLeft'), { kind: 'keys', keys: ['Left'] });
  assert.deepEqual(press('ArrowRight'), { kind: 'keys', keys: ['Right'] });
});

test('shift variants are chords', () => {
  assert.deepEqual(press('Tab', { shiftKey: true }), { kind: 'keys', keys: ['shift+tab'] });
  assert.deepEqual(press('ArrowDown', { shiftKey: true }), { kind: 'keys', keys: ['shift+down'] });
});

test('modifier chords are keys, never text', () => {
  assert.deepEqual(press('c', { ctrlKey: true }), { kind: 'keys', keys: ['ctrl+c'] });
  assert.deepEqual(press('x', { altKey: true }), { kind: 'keys', keys: ['alt+x'] });
  assert.deepEqual(press('ArrowUp', { altKey: true }), { kind: 'keys', keys: ['alt+Up'] });
  assert.deepEqual(press('Enter', { ctrlKey: true }), { kind: 'keys', keys: ['ctrl+Enter'] });
  assert.deepEqual(press('p', { metaKey: true }), { kind: 'keys', keys: ['cmd+p'] });
  assert.deepEqual(press('p', { ctrlKey: true, shiftKey: true }), { kind: 'keys', keys: ['ctrl+shift+p'] });
});

test('modifier-only, IME and keys herdr cannot express send nothing', () => {
  assert.equal(press('Shift'), null);
  assert.equal(press('Control'), null);
  assert.equal(press('Process'), null, 'IME composition in progress');
  assert.equal(press('Dead'), null);
  assert.equal(press('PageUp'), null, 'herdr rejects PageUp');
  assert.equal(press('Delete'), null);
  assert.equal(press('Home'), null);
});

test('a paste or an IME commit is typed in one call', () => {
  assert.deepEqual(textToAction('hello there'), { kind: 'text', text: 'hello there' });
  assert.deepEqual(textToAction('你好'), { kind: 'text', text: '你好' });
  assert.equal(textToAction(''), null);
});
