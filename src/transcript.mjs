// Reading an agent's own transcript, instead of reverse-engineering its screen.
//
// Both mature clients in this space (herdr-mobile-relay, collie) converge on the
// same shape: one adapter per agent, normalising its session file into a single
// entry model, read in bounded pages. herdr hands us the file via
// `agent_session` (kind: "path"), so nothing has to be guessed.
//
// This file is the pi adapter. A new agent = a new `read<Agent>Session` plus a
// line in ADAPTERS; the client only ever sees the normalised entries.

const MAX_PAGE = 200;
const DEFAULT_PAGE = 60;

export const ADAPTERS = { pi: readPiSession };

/** Pick the adapter for a pane's agent, or null when we cannot read it. */
export function adapterFor(agent) {
  return ADAPTERS[String(agent ?? '').toLowerCase()] ?? null;
}

export function readPiSession(text) {
  const meta = { provider: null, model: null, cwd: null, sessionId: null };
  const entries = [];
  const toolIndex = new Map(); // toolCallId -> tool object, so results land on their call

  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line); // a half-written last line is normal while streaming
    } catch {
      continue;
    }

    if (event.type === 'session') {
      meta.sessionId = event.id ?? meta.sessionId;
      meta.cwd = event.cwd ?? meta.cwd;
      continue;
    }
    if (event.type === 'model_change') {
      meta.provider = event.provider ?? meta.provider;
      meta.model = event.modelId ?? meta.model;
      continue;
    }
    if (event.type !== 'message') continue;

    const message = event.message ?? {};
    const parts = Array.isArray(message.content) ? message.content : [];
    const role = message.role;

    if (role === 'system') continue; // prompt scaffolding, not conversation

    if (role === 'user') {
      const text = joinParts(parts, 'text');
      if (text) entries.push({ kind: 'user', text, ts: message.timestamp ?? null });
      continue;
    }

    if (role === 'assistant') {
      const tools = parts
        .filter((part) => part?.type === 'toolCall')
        .map((part) => {
          const tool = {
            id: part.id ?? null,
            name: part.name ?? 'tool',
            input: stringifyInput(part.arguments),
            output: undefined,
            error: false,
            durationMs: undefined,
          };
          if (tool.id) toolIndex.set(tool.id, tool);
          return tool;
        });
      entries.push({
        kind: 'assistant',
        text: joinParts(parts, 'text'),
        thinking: joinParts(parts, 'thinking'),
        tools,
        model: message.model ?? null,
        ts: message.timestamp ?? null,
      });
      continue;
    }

    if (role === 'toolResult') {
      const tool = message.toolCallId ? toolIndex.get(message.toolCallId) : undefined;
      const output = joinParts(parts, 'text');
      if (tool) {
        tool.output = output;
        tool.error = Boolean(message.isError);
        tool.durationMs = message.durationMs;
      } else {
        // A result whose call scrolled out of the page we kept: keep the evidence.
        entries.push({
          kind: 'result',
          toolName: message.toolName ?? 'tool',
          toolCallId: message.toolCallId ?? null,
          output,
          error: Boolean(message.isError),
          ts: message.timestamp ?? null,
        });
      }
    }
  }

  return { meta, entries };
}

/** The newest `limit` entries before `before` (an index), newest last. */
export function pageEntries(entries, { before, limit = DEFAULT_PAGE } = {}) {
  const all = Array.isArray(entries) ? entries : [];
  const size = Math.min(MAX_PAGE, Math.max(1, Number(limit) || DEFAULT_PAGE));
  const end = Number.isInteger(before) && before >= 0 ? Math.min(before, all.length) : all.length;
  const start = Math.max(0, end - size);
  return { entries: all.slice(start, end), hasMore: start > 0, nextBefore: start };
}

function joinParts(parts, type) {
  return parts
    .filter((part) => part?.type === type)
    .map((part) => (type === 'thinking' ? part.thinking : part.text) ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function stringifyInput(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  // A single command reads better unquoted; everything else stays JSON.
  const keys = Object.keys(args);
  if (keys.length === 1 && typeof args[keys[0]] === 'string') return args[keys[0]];
  return JSON.stringify(args);
}
