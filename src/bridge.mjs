// Turns herdr's event stream into browser pokes.
//
// herdr has no "pane output changed" subscription and its `revision` is a stub,
// so events are only used to invalidate: the browser refetches state, and the
// pane it has open is polled separately. A missed event costs one refresh.
import { HerdrError } from './herdr.mjs';

export const GLOBAL_EVENT_TYPES = [
  'workspace.created',
  'workspace.updated',
  'workspace.renamed',
  'workspace.closed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.focused',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'tab.focused',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
];

// Subscription types are dotted (`pane.created`); streamed frame names use
// underscores (`pane_created`). Accept both so a rename cannot silently mute us.
const STRUCTURE_EVENTS = new Set(GLOBAL_EVENT_TYPES.flatMap((type) => [type, type.replaceAll('.', '_')]));

function fingerprintOf(snapshot) {
  if (!snapshot) return '';
  const workspaces = (snapshot.workspaces ?? []).map((w) => [w.workspace_id, w.label, w.agent_status, w.focused]);
  const tabs = (snapshot.tabs ?? []).map((t) => [t.tab_id, t.label, t.pane_count]);
  const panes = (snapshot.panes ?? []).map((p) => [p.pane_id, p.agent, p.agent_status, p.terminal_title_stripped ?? p.terminal_title, p.label, p.focused]);
  return JSON.stringify([snapshot.focused_pane_id, workspaces, tabs, panes]);
}

export class EventBridge {
  #client;
  #onFrame;
  #debounceMs;
  #refreshMs;
  #subscription = null;
  #currentSubs = null;
  #refreshTimer = null;
  #periodicTimer = null;
  #fingerprint = null;
  #stopped = false;
  #connected = false;

  constructor({ client, onFrame = () => {}, debounceMs = 500, refreshMs = 8000 }) {
    this.#client = client;
    this.#onFrame = onFrame;
    this.#debounceMs = debounceMs;
    this.#refreshMs = refreshMs;
  }

  get connected() {
    return this.#connected;
  }

  async start() {
    await this.refresh();
    this.#periodicTimer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.#refreshMs);
    if (this.#periodicTimer.unref) this.#periodicTimer.unref();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#refreshTimer);
    clearInterval(this.#periodicTimer);
    this.#subscription?.close();
    this.#subscription = null;
  }

  /**
   * Rebuild the subscription so it covers every pane that currently hosts an
   * agent. Runs on a short timer as well as on structural events: herdr can
   * detect an agent after we subscribed, and a missed status event would
   * otherwise leave the browser showing a stale status until the next reload.
   */
  async refresh() {
    if (this.#stopped) return;
    let snapshot;
    try {
      snapshot = await this.#client.rpc('session.snapshot');
    } catch (error) {
      if (error instanceof HerdrError) {
        this.#connected = false;
        this.#onFrame({ t: 'herdr', connected: false, reason: error.code });
        return;
      }
      throw error;
    }

    // herdr does not emit an event for every change a browser can see: an agent
    // settling from `unknown` to `idle` is silent. Compare a cheap fingerprint
    // of the visible state and poke the browser when it moves.
    const fingerprint = fingerprintOf(snapshot.snapshot);
    if (this.#fingerprint !== null && fingerprint !== this.#fingerprint) {
      this.#onFrame({ t: 'state' });
    }
    this.#fingerprint = fingerprint;

    const agentPanes = (snapshot.snapshot?.agents ?? []).map((agent) => agent.pane_id).filter(Boolean);
    const subs = [...GLOBAL_EVENT_TYPES.map((type) => ({ type })), ...agentPanes.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id }))];
    const key = JSON.stringify(subs);
    if (key === this.#currentSubs && this.#subscription) return;
    this.#currentSubs = key;

    if (!this.#subscription) {
      this.#subscription = this.#client.subscribe({
        subscriptions: subs,
        onEvent: (event, data) => this.#handleEvent(event, data),
        onStatus: (status) => {
          this.#connected = status === 'connected';
          this.#onFrame({ t: 'herdr', connected: this.#connected });
        },
      });
    } else {
      this.#subscription.update(subs);
    }
  }

  #handleEvent(event, data) {
    if (event === 'pane_agent_status_changed') {
      this.#onFrame({ t: 'agent', pane_id: data.pane_id, status: data.agent_status, title: data.title ?? null });
      return;
    }
    if (event === 'pane_output_changed') {
      this.#onFrame({ t: 'output', pane_id: data.pane_id }); // not subscribable today, handled if it ever ships
      return;
    }
    if (STRUCTURE_EVENTS.has(event)) {
      this.#onFrame({ t: 'state' });
      this.#scheduleRefresh();
    }
  }

  #scheduleRefresh() {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.refresh().catch(() => {});
    }, this.#debounceMs);
    if (this.#refreshTimer.unref) this.#refreshTimer.unref();
  }
}
