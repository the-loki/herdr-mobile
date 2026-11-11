import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/server.mjs';

const TOKEN = 'test-token-0123456789';

/** A stand-in API: echoes the parsed request so the transport can be asserted. */
const api = {
  async handle({ method, path: routePath, query, body }) {
    if (routePath === '/api/boom') return { status: 400, body: { error: { code: 'invalid_params', message: 'nope' } } };
    return { status: 200, body: { method, path: routePath, query: Object.fromEntries(query), body } };
  },
};

/** A terminal stand-in: emits the frames a herdr observer would write. */
function fakeTerminal(options = {}) {
  const terminal = new EventEmitter();
  terminal.options = options;
  terminal.stopped = false;
  terminal.start = () => {
    if (options.failWith) return terminal.emit('error', new Error(options.failWith));
    terminal.emit('frame', { seq: 1, encoding: 'ansi', width: options.cols, height: options.rows, full: true, bytes: 'aGVsbG8=' });
  };
  terminal.stop = () => {
    terminal.stopped = true;
  };
  return terminal;
}

/** Read an SSE body until the accumulated text matches (writes coalesce). */
async function readUntil(reader, predicate, { timeoutMs = 2000 } = {}) {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!predicate(text)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for SSE data, had: ${JSON.stringify(text.slice(-200))}`);
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now()))),
    ]);
    if (chunk.timeout) throw new Error(`timed out reading SSE, had: ${JSON.stringify(text.slice(-200))}`);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

async function withServer(t, { spawnTerminal } = {}) {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(webRoot, 'app.js'), 'console.log(1)');
  const spawned = [];
  const { server, broadcast, close } = createServer({
    api,
    token: TOKEN,
    webRoot,
    spawnTerminal: (options) => {
      const terminal = spawnTerminal ? spawnTerminal(options) : fakeTerminal(options);
      spawned.push(terminal);
      return terminal;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await close();
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { base, broadcast, spawned, close };
}

test('API requests need the pairing token', async (t) => {
  const { base } = await withServer(t);

  const anonymous = await fetch(`${base}/api/state`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, 'unauthorized');

  const wrong = await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);

  const bearer = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(bearer.status, 200);
});

test('a pairing link exchanges the query token for a cookie', async (t) => {
  const { base } = await withServer(t);

  const paired = await fetch(`${base}/api/state?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(paired.status, 200);
  const cookie = paired.headers.get('set-cookie');
  assert.match(cookie, /^hmw=test-token-0123456789;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const withCookie = await fetch(`${base}/api/state`, { headers: { cookie: `hmw=${TOKEN}` } });
  assert.equal(withCookie.status, 200);
});

test('opening the pairing link sets the cookie from the app shell too', async (t) => {
  const { base } = await withServer(t);

  const shell = await fetch(`${base}/?token=${TOKEN}`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('set-cookie') ?? '', /^hmw=test-token-0123456789;/);

  const api = await fetch(`${base}/api/state`, { headers: { cookie: `hmw=${TOKEN}` } });
  assert.equal(api.status, 200);
});

test('POST rejects a non-JSON content type (CSRF guard)', async (t) => {
  const { base } = await withServer(t);

  const res = await fetch(`${base}/api/pane/w1:p1/input`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
    body: JSON.stringify({ text: 'hi' }),
  });
  assert.equal(res.status, 415);
});

test('POST rejects an oversized body', async (t) => {
  const { base } = await withServer(t);

  const res = await fetch(`${base}/api/pane/w1:p1/input`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(300 * 1024) }),
  });
  assert.equal(res.status, 413);
});

test('POST forwards parsed JSON to the API', async (t) => {
  const { base } = await withServer(t);

  const res = await fetch(`${base}/api/pane/w1:p1/input?x=1`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello', submit: true }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.body, { text: 'hello', submit: true });
  assert.deepEqual(body.query, { x: '1' });
});

test('API errors keep their status and code', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/boom`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_params');
});

test('the shell is served without a token, with security headers', async (t) => {
  const { base } = await withServer(t);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<title>app<\/title>/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');

  const script = await fetch(`${base}/app.js`);
  assert.match(script.headers.get('content-type'), /javascript/);
});

test('static serving never escapes the web root', async (t) => {
  const { base } = await withServer(t);

  for (const attempt of ['/../../etc/passwd', '/..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
    const res = await fetch(`${base}${attempt}`);
    assert.equal(res.status, 404, attempt);
  }
});

test('SSE streams broadcast frames to connected clients', async (t) => {
  const { base, broadcast } = await withServer(t);

  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /: connected/);

  broadcast({ t: 'state' });
  const second = decoder.decode((await reader.read()).value);
  assert.equal(second, 'data: {"t":"state"}\n\n');

  controller.abort();
});

test('the terminal stream relays frames and stops herdr when the client leaves', async (t) => {
  const { base } = await withServer(t);

  const controller = new AbortController();
  const res = await fetch(`${base}/api/pane/w1:p1/terminal?cols=60&rows=12`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const text = await readUntil(reader, (body) => /event: frame/.test(body));
  assert.match(text, /: connected/);
  assert.match(text, /event: frame/);
  const payload = JSON.parse(text.split('data: ')[1].split('\n\n')[0]);
  assert.deepEqual(payload, { seq: 1, encoding: 'ansi', width: 60, height: 12, full: true, bytes: 'aGVsbG8=' });

  await reader.cancel();
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('the terminal stream asks herdr for the geometry the phone wants', async (t) => {
  const { base, spawned } = await withServer(t);
  const controller = new AbortController();
  const res = await fetch(`${base}/api/pane/w1:p1/terminal?cols=42&rows=9`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  await readUntil(reader, (body) => /event: frame/.test(body));
  await reader.cancel();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.paneId, 'w1:p1');
  assert.equal(spawned[0].options.cols, 42);
  assert.equal(spawned[0].options.rows, 9);
  controller.abort();
});

test('the terminal stream tells the client when herdr dies, and closes', async (t) => {
  const { base } = await withServer(t, { spawnTerminal: (options) => fakeTerminal({ ...options, failWith: 'herdr is not installed' }) });
  const res = await fetch(`${base}/api/pane/w1:p1/terminal`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  assert.match(text, /event: error/);
  assert.match(text, /herdr is not installed/);
  assert.match(text, /event: closed/);
});

test('the terminal stream refuses a pane id it cannot use and geometry it cannot parse', async (t) => {
  const { base } = await withServer(t);
  const badId = await fetch(`${base}/api/pane/%2e%2e%2fetc%2fpasswd/terminal`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(badId.status, 400);
  const badGeometry = await fetch(`${base}/api/pane/w1:p1/terminal?cols=nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(badGeometry.status, 400);
  assert.equal((await badGeometry.json()).error.code, 'invalid_params');
  const withToken = await fetch(`${base}/api/pane/w1:p1/terminal`);
  assert.equal(withToken.status, 401);
});
