import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, displayHost, pairingUrl } from '../src/app.mjs';
import { startFakeHerdr } from './helpers/fake-herdr.mjs';

const TOKEN = 'app-test-token';

function snapshot() {
  return {
    type: 'session_snapshot',
    snapshot: {
      version: '0.9.5',
      protocol: 22,
      focused_workspace_id: 'w1',
      focused_tab_id: 'w1:t1',
      focused_pane_id: 'w1:p1',
      workspaces: [{ workspace_id: 'w1', number: 1, label: 'demo', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'blocked' }],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'main', pane_count: 1 }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', focused: true, cwd: '/tmp/proj', agent: 'pi', agent_status: 'blocked', terminal_title: 'π - proj' }],
      agents: [{ pane_id: 'w1:p1', agent: 'pi' }],
      layouts: [],
    },
  };
}

test('the app serves state, pane text and live event frames end to end', async (t) => {
  let push;
  const fake = await startFakeHerdr((req, ctx) => {
    if (req.method === 'session.snapshot') return snapshot();
    if (req.method === 'pane.read') return { type: 'pane_read', read: { text: 'hello from pi', revision: 0, truncated: false } };
    push = ctx.push;
    return undefined;
  });
  t.after(() => fake.close());

  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-app-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>app</title>');
  const app = createApp({ config: { socketPath: fake.socketPath, token: TOKEN, port: 0, host: '127.0.0.1' }, webRoot });
  t.after(async () => {
    await app.close();
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  const address = await app.start();
  const base = `http://127.0.0.1:${address.port}`;
  const auth = { authorization: `Bearer ${TOKEN}` };

  const state = await (await fetch(`${base}/api/state`, { headers: auth })).json();
  assert.equal(state.workspaces[0].label, 'demo');
  assert.equal(state.panes[0].agent_status, 'blocked');
  assert.equal(state.server.version, '0.9.5');

  const pane = await (await fetch(`${base}/api/pane/w1:p1?source=visible`, { headers: auth })).json();
  assert.equal(pane.text, 'hello from pi');

  // The bridge should be subscribed by now; a pushed status change must reach SSE.
  await waitFor(() => typeof push === 'function');
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/events`, { headers: auth, signal: controller.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // ": connected"

  push({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle', title: 'π - proj' } });
  const frame = await readFrame(reader, decoder);
  assert.deepEqual(frame, { t: 'agent', pane_id: 'w1:p1', status: 'idle', title: 'π - proj' });

  controller.abort();
});

test('pairing links carry the token and hide a wildcard bind', () => {
  assert.equal(pairingUrl({ host: '127.0.0.1', port: 7777, token: 'abc' }), 'http://127.0.0.1:7777/?token=abc');
  assert.equal(pairingUrl({ host: '0.0.0.0', port: 7777, token: 'abc' }), 'http://127.0.0.1:7777/?token=abc');
  assert.equal(pairingUrl({ host: '::', port: 7777, token: 'abc' }), 'http://127.0.0.1:7777/?token=abc');
  assert.equal(
    pairingUrl({ host: '0.0.0.0', port: 7777, token: 'abc', publicUrl: 'https://herd.example.ts.net/' }),
    'https://herd.example.ts.net/?token=abc',
  );
  assert.equal(displayHost('::1'), '[::1]');
});

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('condition not met in time');
}

async function readFrame(reader, decoder) {
  let buffer = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const match = /data: (.+)\n\n/.exec(buffer);
    if (match) return JSON.parse(match[1]);
  }
  throw new Error('no SSE frame arrived');
}
