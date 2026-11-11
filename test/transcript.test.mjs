import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pageEntries, readPiSession } from '../src/transcript.mjs';

const fixture = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'pi-session.jsonl'), 'utf8');

test('a pi session yields one normalised conversation', () => {
  const session = readPiSession(fixture);

  assert.equal(session.meta.provider, 'ollama-corp');
  assert.equal(session.meta.model, 'deepseek-v4.1-flash:1017-cloud');
  assert.equal(session.meta.cwd, '/home/loki/Workspace/herdr-mobile');

  const kinds = session.entries.map((entry) => entry.kind);
  assert.deepEqual(kinds, ['user', 'assistant', 'assistant']);
});

test('an assistant entry keeps its text, thinking and tool calls', () => {
  const [user, first] = readPiSession(fixture).entries;

  assert.match(user.text, /Goal mode is active/);
  assert.equal(first.kind, 'assistant');
  assert.ok(first.text.length > 0, 'assistant text survives');
  assert.ok(first.thinking?.length > 0, 'thinking is kept separately from the answer');
  assert.equal(first.tools.length, 2);
  assert.equal(first.tools[0].name, 'bash');
  // A single-argument call keeps the argument readable instead of JSON quoting it.
  assert.match(first.tools[0].input, /^[^"{]/);
  assert.equal(first.tools[0].input.includes('{"'), false);
});

test('a tool result is attached to the call it answers', () => {
  const first = readPiSession(fixture).entries[1];

  assert.equal(first.tools[0].output.length > 0, true, 'the result body lands on the call');
  assert.equal(first.tools[1].output, undefined, 'a call without a result has no output');
  assert.equal(first.tools[0].error, false);
});

test('system messages and unknown events are left out, not rendered', () => {
  const text = [
    JSON.stringify({ type: 'session', id: 's1', cwd: '/tmp' }),
    JSON.stringify({ type: 'message', message: { role: 'system', content: [{ type: 'text', text: 'you are pi' }] } }),
    JSON.stringify({ type: 'some_future_event', payload: { anything: true } }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n');

  const session = readPiSession(text);
  assert.deepEqual(session.entries.map((entry) => entry.kind), ['user']);
});

test('a half-written last line is ignored instead of throwing', () => {
  const truncated = `${fixture.trimEnd()}\n{"type":"message","message":{"role":"user","content":[{"type":"te`;
  const session = readPiSession(truncated);
  assert.equal(session.entries.filter((entry) => entry.kind === 'user').length, 1);
});

test('reading is paged from the end, newest last', () => {
  const session = readPiSession(fixture);
  const lastOne = pageEntries(session.entries, { limit: 1 });
  assert.equal(lastOne.entries.length, 1);
  assert.equal(lastOne.entries[0].kind, 'assistant');
  assert.equal(lastOne.hasMore, true);

  const older = pageEntries(session.entries, { before: lastOne.nextBefore, limit: 5 });
  assert.equal(older.entries.length, 2);
  assert.equal(older.hasMore, false);
  assert.deepEqual(
    [...older.entries, ...lastOne.entries].map((entry) => entry.kind),
    ['user', 'assistant', 'assistant'],
  );
});

test('a tool call id survives so results can be matched later', () => {
  const first = readPiSession(fixture).entries[1];
  assert.match(first.tools[0].id, /^call_/);
  assert.equal(first.tools[0].durationMs >= 0, true);
});
