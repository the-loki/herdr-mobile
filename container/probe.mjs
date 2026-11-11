// Protocol probe: verifies the contracts the plugin depends on against the
// herdr server running inside the test container. Run with:
//   node container/probe.mjs
import net from 'node:net';

const SOCK = process.env.HERDR_SOCKET_PATH ?? '/root/.config/herdr/herdr.sock';
let seq = 0;

// One request per connection: herdr closes the socket after a single reply.
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `probe-${++seq}`;
    const sock = net.createConnection(SOCK);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout: ${method}`));
    }, 15000);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
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
    sock.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

function subscribe(types, ms, onEvent) {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCK);
    let buf = '';
    const events = [];
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        events.push(msg);
        onEvent?.(msg);
      }
    });
    sock.write(
      JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: types } }) + '\n',
    );
    setTimeout(() => {
      sock.destroy();
      resolve(events);
    }, ms);
  });
}

const report = {};
const ok = (k, v) => {
  report[k] = v;
};

const ping = await rpc('ping');
ok('ping', ping.result);

const snap = await rpc('session.snapshot');
const snapData = snap.result.snapshot;
ok('snapshot_keys', Object.keys(snapData));
ok('snapshot_workspaces', snapData.workspaces.length);
ok('pane_record', snapData.panes[0]);
ok('agent_record', snapData.agents[0]);

// Second request on an already-answered connection must not reply.
const twoOnOne = await new Promise((resolve) => {
  const sock = net.createConnection(SOCK);
  let buf = '';
  sock.on('data', (d) => (buf += d));
  sock.on('error', () => {});
  sock.on('close', () => resolve(buf.split('\n').filter(Boolean)));
  const send = (id) => {
    try {
      sock.write(JSON.stringify({ id, method: 'ping', params: {} }) + '\n');
    } catch {
      /* server already closed the one-shot socket */
    }
  };
  sock.write(JSON.stringify({ id: 'one', method: 'ping', params: {} }) + '\n');
  setTimeout(() => send('two'), 100);
  setTimeout(() => sock.destroy(), 1200);
});
ok('replies_on_one_connection', twoOnOne.length);

// A scratch workspace with a plain shell pane.
const created = await rpc('workspace.create', { cwd: '/tmp', label: 'probe', focus: false });
const paneId = created.result.root_pane.pane_id;
const wsId = created.result.workspace.workspace_id;
ok('workspace_create', { wsId, paneId, tabs: created.result.tab.tab_id });

// Input: text + keys in one request.
ok('send_input', await rpc('pane.send_input', { pane_id: paneId, text: 'echo probe-$((40+2))', keys: ['Enter'] }));
await new Promise((r) => setTimeout(r, 1200));

const readVisible = await rpc('pane.read', { pane_id: paneId, source: 'visible', format: 'text' });
ok('read_visible', {
  type: readVisible.result?.type,
  revision: readVisible.result?.read?.revision,
  tail: readVisible.result?.read?.text?.split('\n').slice(-4),
});
const readRecent = await rpc('pane.read', { pane_id: paneId, source: 'recent', lines: 10, format: 'text' });
ok('read_recent', readRecent.result?.read?.text?.split('\n').slice(-3));
const readUnwrapped = await rpc('pane.read', { pane_id: paneId, source: 'recent_unwrapped', lines: 10, format: 'text' });
ok('read_recent_unwrapped', readUnwrapped.error ?? readUnwrapped.result?.read?.text?.split('\n').slice(-2));
const readHyphen = await rpc('pane.read', { pane_id: paneId, source: 'recent-unwrapped', lines: 5 });
ok('read_hyphen_variant', readHyphen.error ?? 'accepted');

// ANSI format, to know whether colours survive.
ok('read_ansi_has_escapes', /\\u001b|\x1b/.test((await rpc('pane.read', { pane_id: paneId, source: 'visible', format: 'ansi' })).result.read.text));

// Key grammar.
ok('key_ctrl_c', (await rpc('pane.send_keys', { pane_id: paneId, keys: ['ctrl+c'] })).result ?? 'err');
ok('key_bad', await rpc('pane.send_keys', { pane_id: paneId, keys: ['PageUp'] }));
ok('pane_not_found', await rpc('pane.read', { pane_id: 'wX:p9', source: 'visible' }));

// Events: global lifecycle + pane-scoped status + output change.
const events = await subscribe(
  [
    { type: 'pane.output_changed' },
    { type: 'pane.created' },
    { type: 'workspace.created' },
  ],
  1500,
  (m) => {
    if (m.event) seen.push(m.event);
  },
);
const seen = [];
ok('subscribe_frames', events.map((e) => e.event ?? e.result?.type));
ok('pane_scoped_without_id', await rpc('events.subscribe', { subscriptions: [{ type: 'pane.agent_status_changed' }] }));

// Does pane.output_changed fire while we type?
const seenEvents = [];
const sub = subscribe([{ type: 'pane.output_changed' }], 2500, (m) => {
  if (m.event) seenEvents.push(m.event);
});
await new Promise((r) => setTimeout(r, 300));
await rpc('pane.send_input', { pane_id: paneId, text: 'echo hi', keys: ['Enter'] });
await sub;
ok('output_changed_events', seenEvents.slice(0, 3));
ok('output_changed_count', seenEvents.length);

// Focus / structure ops the web UI exposes.
ok('pane_focus', (await rpc('pane.focus', { pane_id: paneId })).result?.type);
ok('pane_rename', (await rpc('pane.rename', { pane_id: paneId, label: 'probe-pane' })).result?.pane?.label);
ok('tab_create', (await rpc('tab.create', { workspace_id: wsId, label: 'probe-tab' })).result?.tab?.label);
ok('pane_split', (await rpc('pane.split', { target_pane_id: paneId, direction: 'right' })).result?.pane?.pane_id);
ok('workspace_close', (await rpc('workspace.close', { workspace_id: wsId })).result?.type);

console.log(JSON.stringify(report, null, 1));
