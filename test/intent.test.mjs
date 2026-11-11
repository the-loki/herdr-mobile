import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parsePaneUi, planTap } from '../web/src/lib/intent.js';

const palette = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'pi-command-palette.txt'), 'utf8');
const modelSelector = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'pi-model-selector.txt'), 'utf8');

function rowOf(text, needle) {
  const rows = text.split('\n');
  const index = rows.findIndex((line) => line.includes(needle));
  assert.notEqual(index, -1, `fixture has a row containing ${needle}`);
  return index;
}

test('a pi command palette is recognised as a list with one highlighted row', () => {
  const ui = parsePaneUi(palette);

  assert.equal(ui.kind, 'list');
  assert.equal(ui.count, 5, 'the (1/73) counter is in the block but is not an option');
  assert.deepEqual(
    ui.options.filter((option) => option.significant).map((option) => option.label),
    ['settings', 'model', 'tree', 'thinking', 'scoped-models'],
  );
  assert.equal(ui.selectedIndex, 0);
  assert.equal(ui.numbered, false);
});

test('tapping the highlighted row confirms it', () => {
  const plan = planTap(palette, rowOf(palette, 'Open settings menu'));
  assert.deepEqual(plan.keys, ['Enter']);
});

test('tapping a row below the highlight moves down then confirms', () => {
  assert.deepEqual(planTap(palette, rowOf(palette, 'Select model')).keys, ['Down', 'Enter']);
  assert.deepEqual(planTap(palette, rowOf(palette, 'Navigate session tree')).keys, ['Down', 'Down', 'Enter']);
  assert.deepEqual(planTap(palette, rowOf(palette, 'Ctrl+P cycling')).keys, ['Down', 'Down', 'Down', 'Down', 'Enter']);
});

test('tapping a row above the highlight moves up', () => {
  const lower = `${palette.split('\n').slice(0, 32).join('\n')}
  settings                        Open settings menu
→ model                           Select model`;
  assert.deepEqual(planTap(lower, rowOf(lower, 'Open settings menu')).keys, ['Up', 'Enter']);
});

test('tapping ordinary output does nothing', () => {
  assert.equal(planTap(palette, rowOf(palette, '/tmp/proj')), null);
  assert.equal(planTap(palette, rowOf(palette, 'Warning: MCP servers')), null);
});

test('a numbered menu is answered with its number', () => {
  const menu = ['Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and do not ask again', '  3. No, and tell me what to do differently (esc)'].join('\n');
  const ui = parsePaneUi(menu);

  assert.equal(ui.kind, 'list');
  assert.equal(ui.numbered, true);
  assert.deepEqual(planTap(menu, rowOf(menu, 'do not ask again')).keys, ['2']);
  assert.deepEqual(planTap(menu, rowOf(menu, '1. Yes')).keys, ['1']);
});

test('a checkbox list toggles without confirming', () => {
  const menu = ['Pick the tools to enable:', '→ [ ] shell', '  [x] edit', '  [ ] network'].join('\n');
  const ui = parsePaneUi(menu);

  assert.equal(ui.kind, 'list');
  assert.equal(ui.options[1].checked, true);
  assert.deepEqual(planTap(menu, rowOf(menu, '[ ] network')).keys, ['Down', 'Down', 'Space']);
});

test('a yes/no prompt is surfaced as two choices', () => {
  const ui = parsePaneUi('Run the migration?\nContinue? (y/n) ');
  assert.equal(ui.kind, 'confirm');
  assert.deepEqual(ui.confirm, { yes: 'y', no: 'n', question: 'Continue? (y/n)' });

  const caps = parsePaneUi('Overwrite the file? [Y/n]');
  assert.deepEqual(caps.confirm, { yes: 'y', no: 'n', question: 'Overwrite the file? [Y/n]' });
});

test('a selection dialog that needs Enter after a digit still plans the digit', () => {
  const menu = ['Select a model', '  1. deepseek-v4.1-flash', '  2. claude-sonnet'].join('\n');
  assert.deepEqual(planTap(menu, rowOf(menu, 'claude-sonnet')).keys, ['2']);
});

test('pi\'s model selector: indented rows map to arrow presses', () => {
  const ui = parsePaneUi(modelSelector);

  assert.equal(ui.kind, 'list');
  assert.equal(ui.count, 10);
  assert.equal(ui.selectedIndex, 0);
  assert.deepEqual(planTap(modelSelector, rowOf(modelSelector, 'claude-haiku-5-5')).keys, ['Down', 'Down', 'Down', 'Down', 'Enter']);
  assert.deepEqual(planTap(modelSelector, rowOf(modelSelector, 'deepseek-v4.1-flash:1017-cloud [ollama-corp]')).keys, ['Enter']);
});

test('the counter and footer under a menu are not choosable', () => {
  assert.equal(planTap(modelSelector, rowOf(modelSelector, '(1/36)')), null);
  assert.equal(planTap(modelSelector, rowOf(modelSelector, 'Enter to select')), null);
});

test('an arrow list without a marker on every row still maps rows correctly', () => {
  const menu = ['  alpha   first', '→ bravo   second', '  charlie  third'].join('\n');
  const ui = parsePaneUi(menu);
  assert.equal(ui.options.length, 3);
  assert.equal(ui.selectedIndex, 1);
  assert.deepEqual(planTap(menu, rowOf(menu, 'charlie')).keys, ['Down', 'Enter']);
});
