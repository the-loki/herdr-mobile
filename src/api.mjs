// The HTTP-facing API. This module is the security boundary: the browser can
// only reach the herdr methods listed here, with validated parameters.
import fs from 'node:fs';
import { HerdrError } from './herdr.mjs';
import { adapterFor, pageEntries } from './transcript.mjs';

const READ_SOURCES = new Set(['visible', 'recent', 'recent_unwrapped', 'detection']);
const MAX_TEXT = 64 * 1024;
const MAX_KEYS = 32;
const MAX_LABEL = 200;
const MAX_LINES = 2000;
const MAX_ARGV = 32;
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

export function createApi({ client }) {
  const routes = buildRoutes();
  // herdr opens a connection per request, so two taps that race could arrive
  // out of order ("y" and Enter landing as Enter then "y"). Writes to one pane
  // are chained; a pane that is not the same is unaffected.
  const paneQueues = new Map();

  function writeToPane(paneId, task) {
    const previous = paneQueues.get(paneId) ?? Promise.resolve();
    const run = previous.then(task, task);
    paneQueues.set(
      paneId,
      run.catch(() => {}),
    );
    return run;
  }

  async function handle({ method, path, query, body }) {
    const route = matchRoute(routes, method, path);
    if (route.error === 404) return fail(404, 'not_found', `no route for ${path}`);
    if (route.error === 405) return fail(405, 'method_not_allowed', `${path} does not accept ${method}`);
    try {
      return await route.handler({ client, params: route.params, query, body: body ?? {}, writeToPane });
    } catch (error) {
      return fail(...httpStatusFor(error), error.code ?? 'error', error.message);
    }
  }

  // The terminal stream has to ask herdr for the pane's *own* size: `terminal
  // session observe` crops to the viewport it is given rather than reflowing,
  // so asking for a phone-sized viewport would cut the right side of the screen
  // off. The size is in the layouts herdr already publishes.
  let layoutCache = { at: 0, rects: new Map() };
  async function paneGeometry(paneId) {
    const now = Date.now();
    if (now - layoutCache.at > 2000) {
      const result = await client.rpc('session.snapshot', {});
      const snapshot = result?.snapshot ?? result;
      const rects = new Map();
      for (const layout of snapshot?.layouts ?? []) {
        for (const pane of layout?.panes ?? []) {
          const rect = pane?.rect;
          if (pane?.pane_id && rect?.width > 0 && rect?.height > 0) {
            rects.set(pane.pane_id, { cols: Math.trunc(rect.width), rows: Math.trunc(rect.height) });
          }
        }
      }
      layoutCache = { at: now, rects };
    }
    return layoutCache.rects.get(paneId) ?? null;
  }

  return { handle, writeToPane, paneGeometry };
}

function matchRoute(routes, method, path) {
  const segments = path.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  const known = [];
  for (const [routeMethod, pattern, handler] of routes) {
    const matched = matchPattern(pattern, segments);
    if (!matched) continue;
    known.push(routeMethod);
    if (routeMethod === method) return { handler, params: matched };
  }
  return { error: known.length ? 405 : 404 };
}

function matchPattern(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const part = pattern[i];
    if (part.startsWith(':')) params[part.slice(1)] = segments[i];
    else if (part !== segments[i]) return null;
  }
  return params;
}

function buildRoutes() {
  return [
  ['GET', ['api', 'health'], async ({ client }) => {
    const pong = await ping(client);
    return ok({ ok: true, version: pong.version, protocol: pong.protocol });
  }],
  ['GET', ['api', 'state'], async ({ client }) => ok(normalizeSnapshot(await client.rpc('session.snapshot')))],
  ['GET', ['api', 'pane', ':paneId'], getPaneText],
  ['GET', ['api', 'pane', ':paneId', 'transcript'], getTranscript],
  ['POST', ['api', 'pane', ':paneId', 'input'], postInput],
  ['POST', ['api', 'pane', ':paneId', 'keys'], postKeys],
  ['POST', ['api', 'pane', ':paneId', 'focus'], async ({ client, params }) => {
    await client.rpc('pane.focus', { pane_id: params.paneId });
    return ok({ ok: true });
  }],
  ['POST', ['api', 'pane', ':paneId', 'rename'], async ({ client, params, body }) => {
    const label = cleanLabel(body.label, { allowEmpty: true });
    if (!label.ok) return label.response;
    const result = await client.rpc('pane.rename', { pane_id: params.paneId, label: label.value || null });
    return ok({ pane: result.pane });
  }],
  ['POST', ['api', 'pane', ':paneId', 'close'], async ({ client, params }) => {
    await client.rpc('pane.close', { pane_id: params.paneId });
    return ok({ ok: true });
  }],
  ['POST', ['api', 'panes', 'split'], postSplit],
  ['POST', ['api', 'panes', 'agent'], postStartAgent],
  ['POST', ['api', 'workspaces'], async ({ client, body }) => {
    const label = cleanLabel(body.label);
    if (!label.ok) return label.response;
    const result = await client.rpc('workspace.create', compact({
      label: label.value ?? null,
      cwd: cleanPath(body.cwd),
    }));
    return ok({ workspace: result.workspace, tab: result.tab, pane: result.root_pane });
  }],
  ['POST', ['api', 'workspaces', ':workspaceId', 'rename'], async ({ client, params, body }) => {
    const label = cleanLabel(body.label);
    if (!label.ok) return label.response;
    const result = await client.rpc('workspace.rename', { workspace_id: params.workspaceId, label: label.value });
    return ok({ workspace: result.workspace });
  }],
  ['POST', ['api', 'workspaces', ':workspaceId', 'close'], async ({ client, params }) => {
    await client.rpc('workspace.close', { workspace_id: params.workspaceId });
    return ok({ ok: true });
  }],
  ['POST', ['api', 'tabs'], async ({ client, body }) => {
    const label = cleanLabel(body.label);
    if (!label.ok) return label.response;
    if (!body.workspace_id) return fail(400, 'invalid_params', 'workspace_id is required');
    const result = await client.rpc('tab.create', compact({
      workspace_id: String(body.workspace_id),
      label: label.value ?? null,
      cwd: cleanPath(body.cwd),
    }));
    return ok({ tab: result.tab, pane: result.root_pane });
  }],
  ['POST', ['api', 'tabs', ':tabId', 'rename'], async ({ client, params, body }) => {
    const label = cleanLabel(body.label);
    if (!label.ok) return label.response;
    const result = await client.rpc('tab.rename', { tab_id: params.tabId, label: label.value });
    return ok({ tab: result.tab });
  }],
  ['POST', ['api', 'tabs', ':tabId', 'close'], async ({ client, params }) => {
    await client.rpc('tab.close', { tab_id: params.tabId });
    return ok({ ok: true });
  }],
  ['POST', ['api', 'notification'], async ({ client, body }) => {
    const title = cleanLabel(body.title);
    if (!title.ok) return title.response;
    const result = await client.rpc('notification.show', compact({ title: title.value, body: cleanLabel(body.body, { optional: true }).value }));
    return ok({ shown: Boolean(result.shown), reason: result.reason });
  }],
  ];
}

const pingCache = new WeakMap();
async function ping(client) {
  if (!pingCache.has(client)) {
    pingCache.set(client, client.rpc('ping').catch((error) => {
      pingCache.delete(client);
      throw error;
    }));
  }
  return pingCache.get(client);
}

async function getPaneText({ client, params, query }) {
  const source = query.get('source') ?? 'visible';
  if (!READ_SOURCES.has(source)) return fail(400, 'invalid_params', `source must be one of ${[...READ_SOURCES].join(', ')}`);
  const requested = Number(query.get('lines'));
  const lines = Number.isFinite(requested) && requested > 0 ? Math.min(MAX_LINES, Math.floor(requested)) : undefined;
  const result = await client.rpc('pane.read', compact({ pane_id: params.paneId, source, lines, format: 'text' }));
  const read = result.read ?? {};
  return ok({ text: read.text ?? '', revision: read.revision ?? 0, truncated: Boolean(read.truncated) });
}

/**
 * The agent's own conversation log, not a reading of its screen. The path comes
 * from herdr's `agent_session`; it is read here and never sent to the browser.
 */
async function getTranscript({ client, params, query }) {
  const info = await client.rpc('pane.get', { pane_id: params.paneId });
  const pane = info.pane ?? {};
  const session = pane.agent_session;
  const adapter = adapterFor(pane.agent ?? session?.agent);

  if (!session || session.kind !== 'path' || !session.value) {
    // Normal state: no integration installed, or no message sent yet.
    return ok({ meta: null, entries: [], hasMore: false, nextBefore: 0, unavailable: 'no-session' });
  }
  if (!adapter) {
    return fail(400, 'transcript_unsupported', `no transcript reader for agent ${pane.agent ?? session.agent ?? 'unknown'}`);
  }

  let text;
  try {
    const stat = fs.statSync(session.value);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > MAX_TRANSCRIPT_BYTES) return fail(413, 'transcript_too_large', 'session file is larger than 16 MB');
    text = fs.readFileSync(session.value, 'utf8');
  } catch {
    // pi writes its file with the first message; until then the conversation is empty.
    return ok({ meta: null, entries: [], hasMore: false, nextBefore: 0, unavailable: 'file-missing' });
  }

  const session_ = adapter(text);
  // Number(null) is 0, which would page from the very beginning: parse only when asked.
  const beforeRaw = query.get('before');
  const limitRaw = query.get('limit');
  const before = beforeRaw === null ? undefined : Number(beforeRaw);
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  const page = pageEntries(session_.entries, {
    before: Number.isFinite(before) ? before : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return ok({ meta: session_.meta, ...page });
}

async function postInput({ client, params, body, writeToPane }) {
  const text = body.text;
  const keys = body.keys;
  if (text !== undefined && typeof text !== 'string') return fail(400, 'invalid_params', 'text must be a string');
  if (text !== undefined && text.length > MAX_TEXT) return fail(413, 'payload_too_large', `text is longer than ${MAX_TEXT} bytes`);
  const keyList = validateKeys(keys);
  if (keyList.error) return keyList.error;
  if (!text && !keyList.value) return fail(400, 'invalid_params', 'send text, keys, or both');

  if (text && keyList.value) {
    await writeToPane(params.paneId, () =>
      client.rpc('pane.send_input', { pane_id: params.paneId, text, keys: keyList.value }),
    );
    return ok({ ok: true });
  }
  if (text) {
    if (!body.submit) {
      // Drafting has to feel like a keyboard: send_text writes the bytes as if
      // typed, while send_input pastes them (bracketed), and a TUI only opens
      // its completion menus for typed text.
      await writeToPane(params.paneId, () => client.rpc('pane.send_text', { pane_id: params.paneId, text }));
      return ok({ ok: true });
    }
    await writeToPane(params.paneId, () =>
      client.rpc('pane.send_input', { pane_id: params.paneId, text, keys: ['Enter'] }),
    );
    return ok({ ok: true });
  }
  await writeToPane(params.paneId, () => client.rpc('pane.send_keys', { pane_id: params.paneId, keys: keyList.value }));
  return ok({ ok: true });
}

async function postKeys({ client, params, body, writeToPane }) {
  const keyList = validateKeys(body.keys);
  if (keyList.error) return keyList.error;
  if (!keyList.value) return fail(400, 'invalid_params', 'keys is required');
  await writeToPane(params.paneId, () => client.rpc('pane.send_keys', { pane_id: params.paneId, keys: keyList.value }));
  return ok({ ok: true });
}

async function postSplit({ client, body }) {
  if (!body.pane_id) return fail(400, 'invalid_params', 'pane_id is required');
  const direction = body.direction === 'down' ? 'down' : 'right';
  const command = body.command === undefined ? undefined : String(body.command);
  if (command !== undefined && (command.length > MAX_TEXT || command.includes('\n'))) {
    return fail(400, 'invalid_params', 'command must be a single line');
  }
  const result = await client.rpc('pane.split', compact({
    target_pane_id: String(body.pane_id),
    direction,
    cwd: cleanPath(body.cwd),
  }));
  const pane = result.pane;
  if (command && pane?.pane_id) {
    await client.rpc('pane.send_input', { pane_id: pane.pane_id, text: command, keys: ['Enter'] });
  }
  return ok({ pane });
}

async function postStartAgent({ client, body }) {
  if (!body.pane_id) return fail(400, 'invalid_params', 'pane_id is required');
  const kind = cleanLabel(body.kind);
  if (!kind.ok || !kind.value) return fail(400, 'invalid_params', 'kind is required');
  const name = cleanLabel(body.name ?? defaultAgentName(kind.value));
  if (!name.ok) return name.response;
  const args = Array.isArray(body.args) ? body.args.map(String) : undefined;
  if (args && args.length > MAX_ARGV) return fail(400, 'invalid_params', 'too many args');
  const result = await client.rpc('agent.start', compact({
    pane_id: String(body.pane_id),
    kind: kind.value,
    name: name.value,
    args,
  }));
  return ok({ agent: result.agent ?? null });
}

function defaultAgentName(kind) {
  const base = String(kind).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return `${base || 'agent'}-${Date.now().toString(36).slice(-4)}`;
}

function validateKeys(keys) {
  if (keys === undefined || keys === null) return { value: undefined };
  if (!Array.isArray(keys)) return { error: fail(400, 'invalid_params', 'keys must be an array') };
  if (keys.length === 0) return { value: undefined };
  if (keys.length > MAX_KEYS) return { error: fail(400, 'invalid_params', `at most ${MAX_KEYS} keys per request`) };
  if (keys.some((k) => typeof k !== 'string' || !k || k.length > 64)) {
    return { error: fail(400, 'invalid_params', 'every key must be a short string') };
  }
  return { value: keys };
}

function cleanLabel(value, { allowEmpty = false, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return { ok: true, value: undefined };
    if (allowEmpty) return { ok: true, value: '' };
    return { ok: false, response: fail(400, 'invalid_params', 'label is required') };
  }
  if (typeof value !== 'string') return { ok: false, response: fail(400, 'invalid_params', 'label must be a string') };
  const trimmed = value.trim();
  if (!trimmed && allowEmpty) return { ok: true, value: '' };
  if (!trimmed) return { ok: false, response: fail(400, 'invalid_params', 'label must not be blank') };
  if (trimmed.length > MAX_LABEL) return { ok: false, response: fail(400, 'invalid_params', `label is longer than ${MAX_LABEL} characters`) };
  return { ok: true, value: trimmed };
}

function cleanPath(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim();
}

function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeSnapshot(result) {
  const snapshot = result.snapshot ?? {};
  const panes = (snapshot.panes ?? []).map(shapePane);
  return {
    server: { version: snapshot.version, protocol: snapshot.protocol },
    focused: {
      workspace_id: snapshot.focused_workspace_id ?? null,
      tab_id: snapshot.focused_tab_id ?? null,
      pane_id: snapshot.focused_pane_id ?? null,
    },
    workspaces: (snapshot.workspaces ?? []).map((w) => ({
      id: w.workspace_id,
      number: w.number,
      label: w.label,
      focused: Boolean(w.focused),
      pane_count: w.pane_count,
      tab_count: w.tab_count,
      active_tab_id: w.active_tab_id,
      agent_status: w.agent_status ?? 'unknown',
    })),
    tabs: (snapshot.tabs ?? []).map((t) => ({
      id: t.tab_id,
      workspace_id: t.workspace_id,
      number: t.number,
      label: t.label,
      pane_count: t.pane_count,
      agent_status: t.agent_status ?? 'unknown',
    })),
    panes,
    agents: panes.filter((pane) => pane.agent),
  };
}

function shapePane(pane) {
  return {
    // Deliberately only the *kind*: the file path never leaves the server.
    agent_session: pane.agent_session
      ? { agent: pane.agent_session.agent, kind: pane.agent_session.kind }
      : null,
    id: pane.pane_id,
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
    focused: Boolean(pane.focused),
    cwd: pane.cwd,
    agent: pane.agent ?? null,
    agent_status: pane.agent_status ?? 'unknown',
    title: pane.terminal_title_stripped ?? pane.terminal_title ?? null,
    label: pane.label ?? null,
    scroll: pane.scroll ?? null,
  };
}

function ok(body) {
  return { status: 200, body };
}

function fail(status, code, message) {
  return { status, body: { error: { code, message } } };
}

function httpStatusFor(error) {
  if (!(error instanceof HerdrError)) return [500, 'internal_error'];
  const code = error.code ?? '';
  if (code === 'socket_error' || code === 'timeout' || code === 'closed') return [502, code];
  if (code.endsWith('_not_found')) return [404, code];
  if (code.startsWith('invalid_') || code === 'agent_blocked' || code === 'platform_unsupported') return [400, code];
  return [500, code];
}
