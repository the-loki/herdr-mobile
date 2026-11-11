# 0001 — Serve the web client from a herdr pane

**Status:** accepted · 2026-11-10

## Context

The client is an HTTP server that must keep running while the user is away from
the desk. Three shapes were on the table: a plugin **pane** (a terminal herdr
supervises), a one-shot plugin **action**, or a **systemd/launchd service** the
plugin merely registers.

What the ecosystem does: [collie](https://github.com/AltanS/collie) chose a
systemd user service precisely so the bridge survives herdr restarts, and keeps
its plugin as a thin launcher; [herdr-mobile-relay](https://github.com/0cv/herdr-mobile-relay)
ships a supervised service with tunnels.

## Decision

The server runs in a herdr **plugin pane** (`[[panes]] serve`), started by a
`serve` action that opens that pane. Actions stay one-shot launchers.

`node src/main.mjs` is the whole interface; where it runs is a supervision
choice, not a code path. The README documents a systemd unit for people who
want it up after a herdr restart.

## Consequences

- Logs are visible in the pane; stopping is closing the tab; nothing is left
  behind after a crash.
- A herdr server restart takes the web client down. Restarting is one
  `herdr plugin action invoke herdr-mobile.web.serve`.
- No privileged install step, and no second deployment artifact to keep in
  sync with the plugin. A user who needs 7×24 supervision opts in with the
  documented unit and the same command.
