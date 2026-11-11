# 0006 — Serialize writes per pane

**Status:** accepted · 2026-11-10

## Context

herdr takes **one request per connection** and opens a fresh socket for each.
Two taps that leave the browser milliseconds apart therefore become two
independent requests, and nothing forces herdr to process them in tap order.

The end-to-end run caught this as a real defect, not a theoretical one: tapping
`y` and then `⏎` at an approval prompt sometimes produced `answered:` (the Enter
arrived first and satisfied `read` with an empty line) and left the stray `y` at
the shell prompt.

## Decision

`src/api.mjs` keeps a promise chain per pane id and every write to that pane
(`pane.send_input`, `pane.send_keys`) runs through it. A rejected write does not
wedge the chain — the next task is queued with both handlers, so a rejected key
is reported to the caller and the following one still runs.

Serialization lives in the server rather than the browser so that two tabs, or a
retry, cannot interleave either.

## Consequences

- Taps keep their order; the approval flow is deterministic.
- Writes to one pane queue behind each other, so a slow write delays the next
  one for that pane only. Other panes are independent.
- Locking is in-process: it orders one server's clients, not two servers pointed
  at the same herdr (an unsupported setup).
- Covered by two unit tests (order plus “at most one write in flight”, and a
  rejected write not wedging the queue) and by the approval step in
  `container/e2e.mjs`, which failed intermittently before the fix.
