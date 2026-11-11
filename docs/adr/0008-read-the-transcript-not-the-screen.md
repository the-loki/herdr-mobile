# 0008 — Read the transcript, not the screen

**Status:** accepted · 2026-11-10

## Context

The first version treated a pane as a screen: render its text, and translate a
tap on a menu row into keys. That is honest about what herdr exposes, but it
makes the phone a small, awkward terminal. The user's objection was exact: *"I
want a better approach, not just forwarding."*

Two independent, mature clients solve this the same way, which is strong
evidence for the shape:

- **herdr-mobile-relay** has `internal/conversation/` (one reader per agent: JSONL,
  SQLite, journals) normalising into `Entry`/`Page`, plus `internal/question/`
  that parses the *screen* for approvals and questions and `PlanInput` that turns
  an intent into keystrokes.
- **collie** has `bridge/journal/` with one `JournalAdapter` per agent producing
  `TranscriptEntry`/`TranscriptPage`, and `web/src/lib/blocks.ts` parsing the
  screen for prompt blocks.

Both keep the terminal for "menus, approvals and other native interactions". Both
read transcripts in **bounded pages**, and both are explicit that transcript
availability does not imply live token streaming.

The decisive fact for us: herdr already tells us where the conversation lives.
`pane.get`/`agent.list` carry `agent_session: {kind: "path", value: "/…/*.jsonl"}`
once the agent's herdr integration is installed. pi's file is a JSONL stream of
`session` / `model_change` / `message` events whose content parts are
`text`, `thinking`, `toolCall`, `toolResult` — a complete, structured exchange,
including every tool's input and output.

## Decision

Split the sources by what each one can actually answer.

| Question | Source |
| --- | --- |
| What did the agent say and do? | the agent's own **transcript**, via `agent_session` |
| Is it waiting, working, done? | herdr's `agent_status` |
| What is it asking me right now? | the **screen** (`pane.read`), because approvals and menus are never in the transcript |
| How do I answer? | typed keys / a prompt — the only write path herdr has |

Concretely, in this repository:

- `src/transcript.mjs`: one adapter per agent (`readPiSession`) normalising into
  `{kind: user | assistant | result, text, thinking, tools[{name,input,output,error,durationMs}]}`.
  Tool results are attached to the call they answer. Half-written lines are
  skipped rather than thrown. `pageEntries` reads newest-first in bounded pages.
- `GET /api/pane/:id/transcript?before=&limit=`: the server resolves the path
  from herdr and reads the file itself. **The path never reaches the browser**,
  and an agent we have no adapter for is refused (`transcript_unsupported`).
  "No file yet" is a normal state (`200` with `unavailable`), not an error —
  pi creates its file with the first message.
- The pane detail gains two tabs: **对话** (default when a transcript exists) and
  **终端** (the previous raw view, with the menu chooser). The conversation
  renders messages, collapsible thinking, and tool cards with their output.

## Consequences

- On a phone you read a conversation, not an 80-column screen: no wrapping
  artefacts, tool output one tap away, thinking collapsed by default.
- Approvals still come from the screen, because no agent writes them to its
  transcript. The chooser from ADR 0007 stays the way to answer them.
- One adapter per agent. pi is implemented; claude/codex/opencode need their own
  reader, and each will differ (JSONL vs SQLite vs journals) — the interface is
  the seam.
- No live token streaming: the file is read on a timer (2 s while working, 8 s
  when idle). A true stream would need an agent-side integration.
- Transcripts are read whole up to 16 MB then paged in memory. relay bounds this
  harder with SQLite indexes and cursors; we should revisit if sessions grow.
- The terminal tab is not going away: it is where menus, approvals, and anything
  the reader does not understand still work.
