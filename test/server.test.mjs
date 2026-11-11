import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.mjs';

const TOKEN = 'test-token-0123456789';

/** A stand-in API: echoes the parsed request so the transport can be asserted. */
const api = {
  async handle({ method, path: routePath, query, body }) {
    if (routePath === '/api/boom') return { status: 400, body: { error: { code: 'invalid_params', message: 'nope' } } };
    return { status: 200, body: { method, path: routePath, query: Object.fromEntries(query), body } };
  },
};

async function withServer(t) {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(webRoot, 'app.js'), 'console.log(1)');
  const { server, broadcast, close } = createServer({ api, token: TOKEN, webRoot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await close();
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { base, broadcast };
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
