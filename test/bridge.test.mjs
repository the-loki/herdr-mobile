import assert from 'node:assert/strict';
import test from 'node:test';
import { EventBridge, GLOBAL_EVENT_TYPES } from '../src/bridge.mjs';
import { HerdrClient } from '../src/herdr.mjs';
import { startFakeHerdr } from './helpers/fake-herdr.mjs';

function snapshotWith(paneIds) {
  return {
    type: 'session_snapshot',
    snapshot: {
      version: '0.9.5',
      protocol: 22,
      workspaces: [],
      tabs: [],
      panes: paneIds.map((pane_id) => ({ pane_id, workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi' })),
      agents: paneIds.map((pane_id) => ({ pane_id, agent: 'pi' })),
      layouts: [],
    },
  };
}

test('start subscribes to global events plus per-agent-pane status', async (t) => {
  const fake = await startFakeHerdr((req) => {
    if (req.method === 'session.snapshot') return snapshotWith(['w1:p1', 'w1:p2']);
    return undefined; // events.subscribe stays open
  });
  t.after(() => fake.close());

  const bridge = new EventBridge({ client: clientFor(fake), onFrame: () => {} });
  t.after(() => bridge.stop());
  await bridge.start();
  await waitFor(() => fake.callsOf('events.subscribe').length > 0);

  const subs = fake.callsOf('events.subscribe').at(-1).params.subscriptions;
  const types = subs.map((s) => s.type);
  assert.ok(types.includes('workspace.created'));
  assert.ok(types.includes('pane.created'));
  assert.deepEqual(
    subs.filter((s) => s.type === 'pane.agent_status_changed'),
    [
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
      { type: 'pane.agent_status_changed', pane_id: 'w1:p2' },
    ],
  );
  assert.ok(GLOBAL_EVENT_TYPES.includes('layout.updated'));
});

test('agent status events become agent frames; structure events become state frames', async (t) => {
  let push;
  const fake = await startFakeHerdr((req, ctx) => {
    if (req.method === 'session.snapshot') return snapshotWith(['w1:p1']);
    push = ctx.push;
    return undefined;
  });
  t.after(() => fake.close());

  const frames = [];
  const bridge = new EventBridge({ client: clientFor(fake), onFrame: (f) => f.t !== 'herdr' && frames.push(f), debounceMs: 5 });
  t.after(() => bridge.stop());
  await bridge.start();
  await waitFor(() => typeof push === 'function');

  push({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'blocked', title: 'π' } });
  push({ event: 'workspace_created', data: { workspace: { workspace_id: 'w2' } } });
  await waitFor(() => frames.length === 2);

  assert.deepEqual(frames[0], { t: 'agent', pane_id: 'w1:p1', status: 'blocked', title: 'π' });
  assert.deepEqual(frames[1], { t: 'state' });
});

test('a structure event refreshes the pane set and resubscribes', async (t) => {
  let snapshotPanes = ['w1:p1'];
  let push;
  const fake = await startFakeHerdr((req, ctx) => {
    if (req.method === 'session.snapshot') return snapshotWith(snapshotPanes);
    push = ctx.push;
    return undefined;
  });
  t.after(() => fake.close());

  const bridge = new EventBridge({ client: clientFor(fake), onFrame: () => {}, debounceMs: 5 });
  t.after(() => bridge.stop());
  await bridge.start();
  await waitFor(() => typeof push === 'function');
  const before = fake.callsOf('events.subscribe').length;

  snapshotPanes = ['w1:p1', 'w2:p1'];
  push({ event: 'pane_created', data: { pane: { pane_id: 'w2:p1' } } });
  await waitFor(() => fake.callsOf('events.subscribe').length > before);

  const subs = fake.callsOf('events.subscribe').at(-1).params.subscriptions;
  const paneSubs = subs.filter((s) => s.type === 'pane.agent_status_changed').map((s) => s.pane_id);
  assert.deepEqual(paneSubs, ['w1:p1', 'w2:p1']);
});

test('a silent status change is picked up by the fingerprint refresh', async (t) => {
  let status = 'unknown';
  let push;
  const fake = await startFakeHerdr((req, ctx) => {
    if (req.method !== 'session.snapshot') {
      push = ctx.push;
      return undefined;
    }
    return {
      type: 'session_snapshot',
      snapshot: {
        version: '0.9.5',
        protocol: 22,
        workspaces: [{ workspace_id: 'w1', label: 'demo', agent_status: status }],
        tabs: [],
        panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', agent_status: status }],
        agents: [{ pane_id: 'w1:p1', agent: 'pi' }],
        layouts: [],
      },
    };
  });
  t.after(() => fake.close());

  const frames = [];
  const bridge = new EventBridge({ client: clientFor(fake), onFrame: (frame) => frames.push(frame), debounceMs: 5 });
  t.after(() => bridge.stop());
  await bridge.start();
  await waitFor(() => typeof push === 'function');

  // No event fires for this: herdr settles an agent without telling anyone.
  status = 'idle';
  await bridge.refresh();
  await waitFor(() => frames.some((frame) => frame.t === 'state'));

  const count = frames.filter((frame) => frame.t === 'state').length;
  await bridge.refresh();
  assert.equal(frames.filter((frame) => frame.t === 'state').length, count, 'an unchanged snapshot does not poke');
});

test('stop closes the subscription', async (t) => {
  const fake = await startFakeHerdr((req) => (req.method === 'session.snapshot' ? snapshotWith([]) : undefined));
  t.after(() => fake.close());

  const bridge = new EventBridge({ client: clientFor(fake), onFrame: () => {} });
  await bridge.start();
  await waitFor(() => bridge.connected === true);
  bridge.stop();
  await waitFor(() => bridge.connected === false);
});

function clientFor(fake) {
  return new HerdrClient({ socketPath: fake.socketPath });
}

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('condition not met in time');
}
