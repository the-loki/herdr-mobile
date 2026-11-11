# 0007 — Choosing from a menu the agent drew as text

**Status:** accepted · 2026-11-10

## Context

Text plus a key strip cannot answer the interaction agents actually use: a menu.
`pi`'s command palette, its model selector, and every approval dialog are drawn
as rows with a highlight marker and no numbers to type:

```
→ settings                        Open settings menu
  model                           <provider/model> — Select model
  tree                            Navigate session tree
  (1/73)
```

From a phone you would have to count rows in wrapped monospace text and press
Down the right number of times. Nobody will do that, and the first version of
this plugin could not do it at all.

Two mechanisms were possible:

1. **Inject terminal mouse events.** Verified to work: `pane.send_text` with
   `\x1b[<0;10;5M` reaches the pane's program verbatim (probe in
   `container/probe3.mjs`). But it only does anything if the program enabled
   mouse reporting, these agents mostly have not, and sending escapes to a
   program that did not enable them types garbage.
2. **Read the menu, plan the keys.** The menu is already text in our hands, so
   translate a tap into the arrow/digit/space presses the TUI expects.

## Decision

Read the menu (`web/src/lib/intent.js`, pure functions) and make it tappable.

- `parsePaneUi(text)` returns a **list** (contiguous rows with a marker, numbers,
  checkboxes or a description column), a **confirm** (`Continue? (y/n)`), or
  nothing. Chrome inside a block — the `(1/73)` counter, a `Key: value` caption,
  a `·` footer — is in the block but is not choosable.
- `planTap(text, row)` returns keys: a digit for a numbered menu (those commit on
  the digit; Enter would answer the next dialog), `Space` for a checkbox,
  otherwise `Down`/`Up` by the row distance plus `Enter`.
- The client renders the list as **real buttons** above the composer
  (`MenuChooser.jsx`): label, description, and which row is highlighted. Tapping
  raw text still works as a fallback (caret position → row), but a wrapped
  390 px screen makes coordinates fragile, so the chooser is the primary path.
- A `(y/n)` prompt becomes two buttons, `y` and `n` followed by Enter.

One herdr behaviour decided how a draft is delivered: `pane.send_input` **pastes**
(bracketed), and a pasted `/` does not open pi's typing menu, while
`pane.send_text` writes the bytes as if typed and does. So `Type only` uses
`send_text`, and `Send` keeps `send_input` (text + Enter atomically, which is
what herdr's own `pane run` does).

## Consequences

- Answering a menu is one tap, on any agent, with no mouse support required.
- The parser is heuristic: it works because agent menus are formulaic. When it
  fails it degrades to the raw text, and the key strip still works.
- Rows are matched by index against the same text the browser renders, so a
  wrapped line cannot shift the plan; the caret maps back to the logical row.
- Covered by 12 unit tests over real `pi` fixtures (command palette and model
  selector captured in `test/fixtures/`), a deterministic TUI menu in the
  container end-to-end run, and an opportunistic check against a real pi pane.
