# Glossary

The words this project uses, in the sense herdr uses them. When a term here
conflicts with a casual reading, this file wins.

## Herdr

- **herdr server** — the long-lived process that owns terminals. Clients (the
  TUI, the CLI, this plugin) talk to it over a local socket.
- **socket API** — newline-delimited JSON over `$HERDR_SOCKET_PATH`. One request
  per connection; the server closes the socket after the reply. Only
  `events.subscribe` keeps it open.
- **workspace** — a named group of tabs, usually one project. `w1`.
- **tab** — one visible layout inside a workspace. `w1:t1`.
- **pane** — one terminal inside a tab. `w1:p1`. A pane exists whether or not a
  program is running in it.
- **agent** — a coding agent herdr recognised in a pane (`pi`, `claude`, …),
  with a **status**: `idle`, `working`, `blocked`, `done`, `unknown`.
  `blocked` means herdr recognised an approval or question dialog.
- **snapshot** — `session.snapshot`: the authoritative one-shot view of
  workspaces, tabs, panes, agents and layouts.
- **pane read** — `pane.read`, a rendered text view of a pane. Sources:
  - **viewport read** (`visible`) — what the operator's screen shows right now.
    Cheap and safe to poll.
  - **scrollback read** (`recent`, `recent_unwrapped`) — more rows than the
    viewport. Asking for more rows than fit makes herdr scroll the operator's
    own terminal to collect them, so this project only does it when the user
    asks.
- **event** — a frame on `events.subscribe`. Subscription types are dotted
  (`pane.created`); the streamed frames are underscored (`pane_created`).
- **plugin** — a directory with `herdr-plugin.toml`. Its **actions** are
  one-shot commands; its **panes** are long-lived terminal entrypoints.
- **plugin state dir** — `HERDR_PLUGIN_STATE_DIR`. This plugin keeps the pairing
  token and the printed link there.

## This plugin

- **pairing token** — 32 random bytes, hex, stored `0600`. The only credential.
- **pairing link** — `http://host:port/?token=…`. Opening it sets the session
  cookie and is the way a phone joins.
- **poke** — a frame on our own SSE stream telling the browser its cached view
  may be stale. Pokes carry no state; the browser refetches the snapshot. Kinds:
  `state` (structure or a changed fingerprint), `agent` (one pane's status),
  `herdr` (connectivity of the herdr socket).
- **fingerprint** — a compact digest of the snapshot used by the bridge to
  detect changes herdr never announces, such as an agent settling from `unknown`
  to `idle`.
- **viewport poll** — the browser re-reading the open pane with `visible` every
  1.2 s while the tab is visible.
- **allowlist** — the herdr methods `src/api.mjs` is willing to call. Anything
  else is unreachable from the browser.
