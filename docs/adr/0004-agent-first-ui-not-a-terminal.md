# 0004 — Agent-first UI, not a terminal emulator

**Status:** accepted · 2026-11-10

## Context

The obvious move is to mirror the terminal. herdr does not expose a PTY byte
stream — only rendered text — so a real emulator is impossible without
re-implementing VT parsing against a lossy source. On a 390 px screen, a
mirrored 80-column grid is also unreadable without zooming and panning.

Prior art: collie deliberately avoids mirroring and parses prompts into tappable
blocks; ovis builds a full terminal because it drives its own PTYs; the relay
shows text plus structured question cards.

## Decision

The primary object is the **agent**, not the screen.

- The list is ordered by attention (`blocked` → `working` → `done` → `idle`),
  grouped by workspace and tab, each row carrying a status chip.
- The detail view is the pane's rendered text — monospace, wrapping on narrow
  screens, sticking to the bottom until the reader scrolls away — plus a reply
  box.
- Answering is deliberately multi-shape: `Send ⏎` (text + Enter in one
  `pane.send_input` request), `Type only` (draft without submitting), and a key
  strip (`Esc`, `Ctrl-C`, `Tab`, arrows, `Enter`, `y`, `n`, `1`, `2`, `3`) for
  approval dialogs and number menus.
- Structure operations are explicit and confirmed where destructive: new
  workspace, new tab, split (optionally with a command such as `pi`), rename,
  close, and “show in terminal” (which moves the operator's real screen, so it
  asks first).
- One DOM, two layouts: a single column with list→detail navigation below
  768 px, a two-column sidebar+detail grid above it.

## Consequences

- No cursor, no mouse, no ANSI colour: colours are stripped server-side
  (`format: text`), which also removes any XSS surface from pane content.
- Approval dialogs are answered by tapping keys rather than by parsed buttons.
  The key strip covers the common shapes; parsing is left as fog on the map.
- The UI is testable by what a user sees in a phone-sized viewport, which is
  how the end-to-end checks are written.
