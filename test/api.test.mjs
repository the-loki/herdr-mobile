import assert from 'node:assert/strict';
import test from 'node:test';
import { HerdrError } from '../src/herdr.mjs';
import { createApi } from '../src/api.mjs';

/** Records every herdr call and answers from a table. */
function stubClient(answers = {}) {
  const calls = [];
  return {
    calls,
    async rpc(method, params) {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(params);
      return answer ?? { type: 'ok' };
    },
  };
}

const api = (client) => createApi({ client });

async function call(client, method, path, body) {
  return api(client).handle({ method, path, query: new URLSearchParams(path.split('?')[1] ?? ''), body });
}

test('GET /api/state normalises a session snapshot', async () => {
  const client = stubClient({
    'session.snapshot': {
      type: 'session_snapshot',
      snapshot: {
        version: '0.9.5',
        protocol: 22,
        focused_workspace_id: 'w1',
        focused_tab_id: 'w1:t1',
        focused_pane_id: 'w1:p1',
        workspaces: [{ workspace_id: 'w1', number: 1, label: 'demo', focused: true, pane_count: 1, agent_status: 'idle' }],
        tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'main', pane_count: 1 }],
        panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', focused: true, cwd: '/tmp', agent: 'pi', agent_status: 'blocked', terminal_title: 'π - demo' }],
        agents: [],
        layouts: [],
      },
    },
  });

  const res = await call(client, 'GET', '/api/state');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.server, { version: '0.9.5', protocol: 22 });
  assert.equal(res.body.focused.pane_id, 'w1:p1');
  assert.equal(res.body.workspaces[0].label, 'demo');
  assert.equal(res.body.panes[0].agent, 'pi');
  assert.equal(res.body.panes[0].agent_status, 'blocked');
  assert.equal(res.body.panes[0].title, 'π - demo');
});

test('GET /api/pane/:id passes a whitelisted source and line count', async () => {
  const client = stubClient({ 'pane.read': { type: 'pane_read', read: { text: 'hello', revision: 0, truncated: false } } });

  const res = await call(client, 'GET', '/api/pane/w1:p1?source=recent_unwrapped&lines=120');

  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'hello');
  assert.deepEqual(client.calls[0], {
    method: 'pane.read',
    params: { pane_id: 'w1:p1', source: 'recent_unwrapped', lines: 120, format: 'text' },
  });
});

test('GET /api/pane/:id rejects sources herdr would not accept', async () => {
  const client = stubClient();
  const res = await call(client, 'GET', '/api/pane/w1:p1?source=../../etc/passwd');

  assert.equal(res.status, 400);
  assert.equal(client.calls.length, 0);
});

test('GET /api/pane/:id clamps an oversized line count', async () => {
  const client = stubClient({ 'pane.read': { read: { text: '' } } });
  await call(client, 'GET', '/api/pane/w1:p1?source=recent&lines=99999');
  assert.equal(client.calls[0].params.lines, 2000);
});

test('POST input submits text and Enter in one herdr request', async () => {
  const client = stubClient();
  const res = await call(client, 'POST', '/api/pane/w1:p1/input', { text: 'run the tests', submit: true });

  assert.equal(res.status, 200);
  assert.deepEqual(client.calls[0], {
    method: 'pane.send_input',
    params: { pane_id: 'w1:p1', text: 'run the tests', keys: ['Enter'] },
  });
});

test('POST input without submit types the text and leaves Enter out', async () => {
  const client = stubClient();
  await call(client, 'POST', '/api/pane/w1:p1/input', { text: 'draft only', submit: false });
  assert.deepEqual(client.calls[0].params, { pane_id: 'w1:p1', text: 'draft only' });
});

test('POST input can send keys alone', async () => {
  const client = stubClient();
  await call(client, 'POST', '/api/pane/w1:p1/input', { keys: ['ctrl+c'] });
  assert.deepEqual(client.calls[0], { method: 'pane.send_keys', params: { pane_id: 'w1:p1', keys: ['ctrl+c'] } });
});

test('POST input rejects an empty request and an oversized payload', async () => {
  const client = stubClient();
  assert.equal((await call(client, 'POST', '/api/pane/w1:p1/input', {})).status, 400);
  assert.equal((await call(client, 'POST', '/api/pane/w1:p1/input', { text: 'x'.repeat(70000) })).status, 413);
  assert.equal((await call(client, 'POST', '/api/pane/w1:p1/input', { keys: Array(40).fill('Enter') })).status, 400);
  assert.equal(client.calls.length, 0);
});

test('POST keys passes the key list through', async () => {
  const client = stubClient();
  const res = await call(client, 'POST', '/api/pane/w1:p1/keys', { keys: ['Down', '1'] });
  assert.equal(res.status, 200);
  assert.deepEqual(client.calls[0], { method: 'pane.send_keys', params: { pane_id: 'w1:p1', keys: ['Down', '1'] } });
});

test('structure endpoints map to their herdr methods', async () => {
  const client = stubClient({
    'workspace.create': { type: 'workspace_created', workspace: { workspace_id: 'w2' }, tab: { tab_id: 'w2:t1' }, root_pane: { pane_id: 'w2:p1' } },
    'tab.create': { type: 'tab_created', tab: { tab_id: 'w2:t2' }, root_pane: { pane_id: 'w2:p2' } },
    'pane.split': { type: 'pane_split', pane: { pane_id: 'w2:p3' } },
    'pane.focus': { type: 'pane_info', pane: { pane_id: 'w2:p1' } },
    'pane.close': { type: 'ok' },
    'workspace.close': { type: 'ok' },
    'tab.close': { type: 'ok' },
    'pane.rename': { type: 'pane_info', pane: { pane_id: 'w2:p1', label: 'x' } },
    'workspace.rename': { type: 'workspace_info', workspace: { workspace_id: 'w2', label: 'y' } },
    'tab.rename': { type: 'tab_info', tab: { tab_id: 'w2:t1', label: 'z' } },
    'agent.start': { type: 'agent_started', agent: { name: 'pi-1' } },
    'notification.show': { type: 'notification_show', shown: true },
  });

  await call(client, 'POST', '/api/workspaces', { label: 'new', cwd: '/tmp' });
  await call(client, 'POST', '/api/tabs', { workspace_id: 'w2', label: 'logs' });
  await call(client, 'POST', '/api/panes/split', { pane_id: 'w2:p1', direction: 'down' });
  await call(client, 'POST', '/api/pane/w2:p1/focus', {});
  await call(client, 'POST', '/api/pane/w2:p1/rename', { label: 'build' });
  await call(client, 'POST', '/api/pane/w2:p1/close', {});
  await call(client, 'POST', '/api/workspaces/w2/rename', { label: 'renamed' });
  await call(client, 'POST', '/api/workspaces/w2/close', {});
  await call(client, 'POST', '/api/tabs/w2:t1/rename', { label: 'renamed tab' });
  await call(client, 'POST', '/api/tabs/w2:t1/close', {});
  await call(client, 'POST', '/api/panes/agent', { pane_id: 'w2:p1', kind: 'pi', name: 'pi-1' });
  await call(client, 'POST', '/api/notification', { title: 'hi' });

  assert.deepEqual(
    client.calls.map((c) => [c.method, c.params]),
    [
      ['workspace.create', { label: 'new', cwd: '/tmp' }],
      ['tab.create', { workspace_id: 'w2', label: 'logs' }],
      ['pane.split', { target_pane_id: 'w2:p1', direction: 'down' }],
      ['pane.focus', { pane_id: 'w2:p1' }],
      ['pane.rename', { pane_id: 'w2:p1', label: 'build' }],
      ['pane.close', { pane_id: 'w2:p1' }],
      ['workspace.rename', { workspace_id: 'w2', label: 'renamed' }],
      ['workspace.close', { workspace_id: 'w2' }],
      ['tab.rename', { tab_id: 'w2:t1', label: 'renamed tab' }],
      ['tab.close', { tab_id: 'w2:t1' }],
      ['agent.start', { pane_id: 'w2:p1', kind: 'pi', name: 'pi-1' }],
      ['notification.show', { title: 'hi' }],
    ],
  );
});

test('a split can start a command in the new pane', async () => {
  const client = stubClient({
    'pane.split': { type: 'pane_split', pane: { pane_id: 'w3:p2' } },
  });

  const res = await call(client, 'POST', '/api/panes/split', { pane_id: 'w3:p1', direction: 'right', command: 'pi' });

  assert.equal(res.status, 200);
  assert.equal(res.body.pane.pane_id, 'w3:p2');
  assert.deepEqual(client.calls[1], {
    method: 'pane.send_input',
    params: { pane_id: 'w3:p2', text: 'pi', keys: ['Enter'] },
  });
});

test('unknown routes and non-allowlisted herdr methods are refused', async () => {
  const client = stubClient();
  assert.equal((await call(client, 'POST', '/api/rpc', { method: 'server.stop' })).status, 404);
  assert.equal((await call(client, 'GET', '/api/nope')).status, 404);
  assert.equal((await call(client, 'DELETE', '/api/state')).status, 405);
  assert.equal(client.calls.length, 0);
});

test('herdr errors map to useful HTTP statuses', async () => {
  const missing = stubClient({ 'pane.read': new HerdrError('pane_not_found', 'pane gone') });
  const res = await call(missing, 'GET', '/api/pane/w9:p9?source=visible');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'pane_not_found');

  const down = stubClient({ 'session.snapshot': new HerdrError('socket_error', 'connect ENOENT') });
  assert.equal((await call(down, 'GET', '/api/state')).status, 502);

  const invalid = stubClient({ 'pane.send_keys': new HerdrError('invalid_key', 'unsupported key PageUp') });
  assert.equal((await call(invalid, 'POST', '/api/pane/w1:p1/keys', { keys: ['PageUp'] })).status, 400);
});
