# 0009 — A real terminal, from herdr's own frames

**Status:** accepted · 2026-11-11 · supersedes the "snapshots only" premise of
[0002](0002-live-enough-without-an-output-event.md)

## Context

ADR 0002 said herdr gives no byte stream: `revision` is always 0, there is no
`pane.output_changed` subscription, and `pane.read` returns text. That was true
of the **socket API**, and wrong about herdr. Since 0.7.2 herdr ships a
purpose-built terminal bridge as a *subprocess* protocol, separate from the
socket:

```
herdr terminal session observe <pane> --cols N --rows M   # read-only, no limit on observers
herdr terminal session control <pane> [--takeover]        # writable, one controller
```

stdout is one JSON object per line:

```json
{"type":"terminal.frame","seq":1,"encoding":"ansi","width":120,"height":40,
 "full":true,"bytes":"<base64 ANSI>"}
```

Three measurements on herdr 0.9.5 decided the design (`container/probe4`–`probe8`):

| Question | Answer |
| --- | --- |
| Does `observe` disturb the pane? | **No.** A 100-column ruler stays 100 columns, and `pane.read` is unchanged, before, during and after an observer at 40×10 asks for its own size |
| Does it reflow to the requested size? | **No, it crops.** At `--cols 30` the 100-character ruler arrives cut at 30; at `--cols 400` the whole line arrives |
| Are frames cheap? | A full repaint at attach, then deltas: 60×12 attach 1156 B, each later change ~152 B |

Prior art splits on exactly this:

- **herdr-mobile-relay** predates the bridge and diffs `pane.read` text itself
  (`internal/panedelta`), explicitly "without streaming terminal frames".
- **derekr/wherdr** feeds vendored ghostty-web (WASM) from these frames.
- **afloury/wherdr** relays `terminal session control` over a WebSocket into
  xterm.js, and on a phone "temporarily fits the real pane to its width and
  restores its size on release... it does not shrink 120 columns into
  unreadable text".

## Decision

The terminal tab is a real terminal, fed by `observe`, at the pane's own size.

1. **Ask for the pane's size, not the phone's.** `observe` crops, so a phone-sized
   viewport would silently cut the right side off every line. herdr publishes the
   pane's cell rectangle in `session.snapshot.layouts[].panes[].rect`, so the
   server resolves `{cols, rows}` from there (`api.paneGeometry`, cached for 2 s)
   and spawns the observer with it.
2. **Watch, never take over.** `observe` is read-only and, as measured, invisible
   to the person at the desk. That is deliberately different from afloury, which
   takes the terminal lease and resizes the pane: this app is a *remote* viewer,
   and silently reshaping someone's working layout from a phone is not a thing it
   should do. The consequence is honest: a 120-column pane on a phone pans
   sideways rather than being reflowed.
3. **The font adapts, the columns do not.** `TerminalView` scales the font to the
   container down to an 8 px floor, then lets the screen scroll, because text
   under 8 px is decoration, not reading.
4. **Reading is not typing.** The terminal is `disableStdin`; replies go through
   the reply box and key strip, which the server serialises per pane (ADR 0006).
   Forwarding single keystrokes from a phone was considered and rejected earlier
   as a worse input model.
5. **The conversation stays the default view** when the agent reports a session
   file (ADR 0008); the terminal is one tap away and is the fallback for menus,
   approvals and anything the transcript does not contain.
6. **Degrade honestly.** If the bridge is missing (herdr < 0.7.2, or the CLI not
   on `PATH` inside a plugin pane) no frame arrives within 4 s, and the tab falls
   back to the polled text view with a note saying why.

## Consequences

- Colours, box drawing, glyphs and the app's own layout reach the phone intact;
  the pi banner and its warning colours render as drawn.
- No new socket methods, no ANSI parsing on the server: frames are base64 in,
  base64 out. The browser decodes them into xterm.
- The polled text view is still there, but only as the fallback, and the screen
  text used by the menu parser now comes from xterm's buffer when the stream is
  live — the authoritative screen rather than a guess.
- One subprocess per open terminal, killed when the client disconnects, the pane
  closes, or the app shuts down.
- The web bundle grew by xterm (~400 KB minified). If that matters it can be
  code-split behind the terminal tab.
- Not done, and deliberately: taking the terminal lease to reflow a wide pane to
  a phone (`control --takeover`, restore on release). It is afloury's answer to
  the same problem and it is the right next step for a narrow screen — but it
  changes what the person at the desk sees, so it needs its own decision and a
  visible lease, not a silent default.
- Also not done: mouse input, scroll *commands* (`terminal.scroll`), and a
  writable controller stream. The write path remains the API.
