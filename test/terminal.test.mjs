import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { GEOMETRY, PaneTerminal, parseGeometry } from '../src/terminal.mjs';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-herdr-terminal.mjs');

/** A stand-in herdr: emits a full frame, a delta, then closes the terminal. */
function fakeTerminal(options = {}) {
  return new PaneTerminal({ paneId: 'w1:p1', bin: process.execPath, spawn: spawnScript, ...options });
}

function spawnScript(bin, args, options) {
  return spawn(bin, [FAKE, ...args], options);
}

const collect = (terminal) =>
  new Promise((resolve) => {
    const frames = [];
    terminal.on('frame', (frame) => frames.push(frame));
    terminal.on('closed', (info) => resolve({ frames, closed: info }));
    terminal.on('error', (error) => resolve({ frames, error }));
  });

test('relays herdr frames in order: a full repaint, then a delta', async () => {
  const terminal = fakeTerminal();
  const done = collect(terminal);
  terminal.start();
  const { frames, closed } = await done;

  assert.equal(frames.length, 2);
  assert.equal(frames[0].seq, 1);
  assert.equal(frames[0].full, true);
  assert.equal(frames[0].width, 80);
  assert.equal(frames[1].seq, 2);
  assert.equal(frames[1].full, false);
  assert.equal(frames[0].encoding, 'ansi');
  // bytes stay base64: the browser decodes them, the server never re-encodes.
  assert.equal(Buffer.from(frames[0].bytes, 'base64').toString('utf8').includes('hello'), true);
  assert.equal(closed.reason.length > 0, true);
  assert.equal(terminal.child, null);
});

test('passes the requested viewport to herdr', async () => {
  const terminal = fakeTerminal({ cols: 42, rows: 9 });
  const done = collect(terminal);
  terminal.start();
  const { frames } = await done;
  // The fake writes its argv into the first frame, so this proves the geometry
  // reached the command line rather than being applied by us.
  const text = Buffer.from(frames[0].bytes, 'base64').toString('utf8');
  assert.match(text, /cols 42/);
  assert.match(text, /rows 9/);
});

test('stops the child when the observer is no longer wanted', async () => {
  const terminal = fakeTerminal();
  terminal.start();
  await new Promise((resolve) => terminal.on('frame', resolve));
  const child = terminal.child;
  assert.ok(child);
  terminal.stop();
  assert.equal(terminal.child, null);
  assert.equal(child.killed, true);
});

test('reports a missing herdr binary instead of crashing', async () => {
  const terminal = new PaneTerminal({ paneId: 'w1:p1', bin: '/nonexistent/herdr' });
  const done = collect(terminal);
  terminal.start();
  const { frames, error } = await done;
  assert.equal(frames.length, 0);
  assert.match(error.message, /ENOENT/);
});

test('refuses frames that are not framable', () => {
  const terminal = fakeTerminal();
  const frames = [];
  terminal.on('frame', (frame) => frames.push(frame));
  terminal.consume('{"type":"terminal.frame","width":0,"height":0,"bytes":"AA=="}\n');
  terminal.consume('{"type":"terminal.frame","width":10,"height":2,"bytes":"<script>"}\n');
  terminal.consume('not json at all\n');
  terminal.consume('\n');
  assert.equal(frames.length, 0);
  terminal.stop();
});

test('stops on a runaway frame count', async () => {
  const terminal = fakeTerminal({ maxFrames: 1 });
  const done = collect(terminal);
  terminal.start();
  const { frames, error } = await done;
  assert.equal(frames.length, 1);
  assert.match(error.message, /more than 1 frames/);
});

test('clamps geometry into a terminal a phone or desktop can have', () => {
  assert.deepEqual(parseGeometry(new URLSearchParams('cols=80&rows=24')), { cols: 80, rows: 24 });
  assert.equal(parseGeometry(new URLSearchParams('cols=1&rows=1')).cols, GEOMETRY.minCols);
  assert.equal(parseGeometry(new URLSearchParams('cols=99999&rows=99999')).cols, GEOMETRY.maxCols);
  assert.equal(parseGeometry(new URLSearchParams('')).cols, 80);
  assert.throws(() => parseGeometry(new URLSearchParams('cols=abc')), RangeError);
});
