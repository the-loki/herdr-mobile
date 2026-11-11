# 0002 — Poke on events, poll the visible screen

> **Partly superseded by [0009](0009-a-real-terminal-from-herdrs-frames.md).**
> The socket API is as described here, but herdr 0.7.2+ also exposes a subprocess
> frame stream (`terminal session observe`), so the terminal no longer has to be
> polled. The 1.2 s viewport poll now only feeds the text fallback.


**Status:** accepted · 2026-11-10

## Context

A browser client wants to feel live. Measured on herdr 0.9.5 (protocol 22,
inside the test container):

- The subscription types number 27 and there is **no** `pane.output_changed`.
  `pane.output_changed` exists only as an event body; subscribing returns
  `unknown variant`. `pane.updated` does not fire when a pane's output changes.
- `revision` is a stub: `0` on every pane, every read, while the text changes.
- `pane.read` costs p50 ≈ 2 ms, p95 ≈ 102 ms; a `session.snapshot` costs about
  the same.
- `recent` with `lines > viewport_rows` makes herdr scroll the operator's own
  terminal to collect the extra rows; `visible` cannot, because it is the
  rendered viewport.
- `unknown → idle` on a freshly started agent emits **no** event at all.

## Decision

1. The server holds one `events.subscribe` stream: all global structural types,
   plus `pane.agent_status_changed` per pane that currently hosts an agent.
   Rebuilt when the pane set changes and on an 8 s timer.
2. Events are **pokes only**. The browser never takes state from them; it
   refetches `session.snapshot` (via `/api/state`) which stays authoritative.
3. Because some changes are silent, the bridge fingerprints each snapshot and
   pokes when the fingerprint moves. A missed event costs one tick, never
   correctness.
4. The open pane is polled with `?source=visible` every 1.2 s, and only while
   `document.visibilityState === 'visible'`.
5. `recent` / `recent_unwrapped` are read only from the explicit
   “Load older output” action.

## Consequences

- Worst case ≈ 8 % of one core while a phone is looking at a pane; nothing at
  all when the tab is hidden.
- The operator's own terminal is never scrolled by this plugin.
- Live-ness is bounded by 1.2 s, not instant — acceptable for reading an agent
  and answering it.
- If herdr ever ships a real output event, `src/bridge.mjs` already recognises
  `pane_output_changed` and forwards it as an `output` poke.
