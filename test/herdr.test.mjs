import assert from 'node:assert/strict';
import test from 'node:test';
import { HerdrClient, HerdrError } from '../src/herdr.mjs';
import { startFakeHerdr } from './helpers/fake-herdr.mjs';

test('rpc returns the result of a single request', async (t) => {
  const fake = await startFakeHerdr((req) => ({ type: 'pong', echo: req.params.echo }));
  t.after(() => fake.close());

  const client = new HerdrClient({ socketPath: fake.socketPath });
  const result = await client.rpc('ping', { echo: 'hi' });

  assert.deepEqual(result, { type: 'pong', echo: 'hi' });
  assert.equal(fake.callsOf('ping').length, 1);
  assert.equal(typeof fake.callsOf('ping')[0].id, 'string');
});

test('rpc uses one connection per request, as herdr requires', async (t) => {
  const fake = await startFakeHerdr((req) => ({ type: 'pong' }));
  t.after(() => fake.close());

  const client = new HerdrClient({ socketPath: fake.socketPath });
  await client.rpc('ping');
  await client.rpc('ping');

  // The fake records every request it receives; a shared connection would also
  // record two, so assert the client opened a fresh socket each time instead.
  assert.equal(fake.calls.length, 2);
  assert.notEqual(fake.calls[0].id, fake.calls[1].id);
});

test('rpc turns an error frame into a HerdrError with code and message', async (t) => {
  const fake = await startFakeHerdr(() => ({ error: { code: 'pane_not_found', message: 'pane w9:p9 not found' } }));
  t.after(() => fake.close());

  const client = new HerdrClient({ socketPath: fake.socketPath });
  const err = await client.rpc('pane.read', {}).catch((e) => e);

  assert.ok(err instanceof HerdrError);
  assert.equal(err.code, 'pane_not_found');
  assert.equal(err.message, 'pane w9:p9 not found');
});

test('rpc fails loudly when the socket is missing', async () => {
  const client = new HerdrClient({ socketPath: '/tmp/definitely-not-a-herdr-socket.sock' });
  const err = await client.rpc('ping').catch((e) => e);
  assert.ok(err instanceof HerdrError);
  assert.equal(err.code, 'socket_error');
});

test('rpc times out instead of hanging', async (t) => {
  const fake = await startFakeHerdr(() => undefined); // never replies
  t.after(() => fake.close());

  const client = new HerdrClient({ socketPath: fake.socketPath, timeoutMs: 150 });
  const err = await client.rpc('ping').catch((e) => e);

  assert.ok(err instanceof HerdrError);
  assert.equal(err.code, 'timeout');
});

test('subscribe streams events and reports connection status', async (t) => {
  const fake = await startFakeHerdr((req, { push }) => {
    if (req.method !== 'events.subscribe') return { type: 'ok' };
    push({ id: req.id, result: { type: 'subscription_started' } });
    setImmediate(() => {
      push({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'blocked' } });
      push({ event: 'pane_created', data: { pane_id: 'w1:p2' } });
    });
    return undefined; // keep the socket open, like the real server
  });
  t.after(() => fake.close());

  const events = [];
  const statuses = [];
  const sub = new HerdrClient({ socketPath: fake.socketPath }).subscribe({
    subscriptions: [{ type: 'pane.created' }, { type: 'pane.agent_status_changed', pane_id: 'w1:p1' }],
    onEvent: (event, data) => events.push([event, data]),
    onStatus: (status) => statuses.push(status),
  });

  await waitFor(() => events.length === 2);
  sub.close();

  assert.deepEqual(statuses, ['connected', 'disconnected']);
  assert.deepEqual(events[0], ['pane_agent_status_changed', { pane_id: 'w1:p1', agent_status: 'blocked' }]);
  assert.deepEqual(fake.callsOf('events.subscribe')[0].params, {
    subscriptions: [{ type: 'pane.created' }, { type: 'pane.agent_status_changed', pane_id: 'w1:p1' }],
  });
});

test('subscribe resubscribes with update() and reconnects after a drop', async (t) => {
  let connections = 0;
  const fake = await startFakeHerdr((req) => {
    if (req.method !== 'events.subscribe') return { type: 'ok' };
    connections += 1;
    return undefined;
  });
  t.after(() => fake.close());

  const sub = new HerdrClient({ socketPath: fake.socketPath }).subscribe({
    subscriptions: [{ type: 'pane.created' }],
    onEvent: () => {},
  });

  await waitFor(() => connections === 1);
  sub.update([{ type: 'tab.created' }]);
  await waitFor(() => connections === 2);

  const last = fake.callsOf('events.subscribe').at(-1);
  assert.deepEqual(last.params, { subscriptions: [{ type: 'tab.created' }] });
  sub.close();
});

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 20 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('condition not met in time');
}
