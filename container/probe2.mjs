// Probe 2: how does a web client learn that a pane's output changed?
// herdr has no `pane.output_changed` subscription; this measures the real
// alternatives (pane.updated revision bumps, agent status, scroll events).
import net from 'node:net';

const SOCK = process.env.HERDR_SOCKET_PATH ?? '/root/.config/herdr/herdr.sock';
let seq = 0;
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout: ${method}`));
    }, 15000);
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        sock.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.write(JSON.stringify({ id: `p-${++seq}`, method, params }) + '\n');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function subscribe(subs, ms, onFrame) {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCK);
    let buf = '';
    const frames = [];
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        frames.push(msg);
        onFrame?.(msg);
      }
    });
    sock.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: subs } }) + '\n');
    setTimeout(() => {
      sock.destroy();
      resolve(frames);
    }, ms);
  });
}

const out = {};
const ws = await rpc('workspace.create', { cwd: '/tmp', label: 'probe2', focus: false });
const pane = ws.result.root_pane.pane_id;
out.pane = pane;

// Baseline revision from snapshot, then type and compare.
const revOf = async () => {
  const s = await rpc('session.snapshot');
  return s.result.snapshot.panes.find((p) => p.pane_id === pane)?.revision;
};
out.rev_before = await revOf();

const frames = [];
const sub = subscribe(
  [
    { type: 'pane.updated' },
    { type: 'pane.created' },
    { type: 'pane.closed' },
    { type: 'pane.focused' },
    { type: 'pane.agent_status_changed', pane_id: pane },
    { type: 'pane.scroll_changed', pane_id: pane },
  ],
  4000,
  (f) => {
    if (f.event) frames.push({ event: f.event, data: f.data });
  },
);
await sleep(400);
await rpc('pane.send_input', { pane_id: pane, text: 'echo one', keys: ['Enter'] });
await sleep(600);
await rpc('pane.send_input', { pane_id: pane, text: 'echo two', keys: ['Enter'] });
await sleep(800);
out.rev_after = await revOf();
await sub;

out.subscribe_ack = frames.length ? 'events flowed' : 'no events';
out.frames = frames.map((f) => ({ event: f.event, keys: Object.keys(f.data ?? {}), revision: f.data?.pane?.revision }));
out.event_names = [...new Set(frames.map((f) => f.event))];

// Invalid subscription type: what does the error look like?
out.invalid_sub = await new Promise((resolve) => {
  const sock = net.createConnection(SOCK);
  let buf = '';
  sock.on('error', () => {});
  sock.on('data', (d) => (buf += d));
  sock.on('close', () => resolve(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  sock.write(JSON.stringify({ id: 'bad', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.output_changed' }] } }) + '\n');
  setTimeout(() => sock.destroy(), 800);
});

// Read the same pane twice to see whether `revision` moves at all.
const r1 = await rpc('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
await rpc('pane.send_input', { pane_id: pane, text: 'echo three', keys: ['Enter'] });
await sleep(500);
const r2 = await rpc('pane.read', { pane_id: pane, source: 'visible', format: 'text' });
out.read_revisions = [r1.result.read.revision, r2.result.read.revision];
out.read_changed = r1.result.read.text !== r2.result.read.text;

// Cheapest change detector available: does `pane.get` expose scroll/revision?
out.pane_get_keys = Object.keys((await rpc('pane.get', { pane_id: pane })).result.pane);

// Agent status subscription on a pane with an agent (pi), if any exists.
const snap = await rpc('session.snapshot');
out.agent_panes = snap.result.snapshot.agents.map((a) => ({ pane: a.pane_id, agent: a.agent, status: a.agent_status, revision: a.revision }));

await rpc('workspace.close', { workspace_id: ws.result.workspace.workspace_id });
console.log(JSON.stringify(out, null, 1));
