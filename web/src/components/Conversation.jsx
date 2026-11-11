import { useState } from 'react';

/**
 * The agent's conversation, rendered as a chat instead of a screen.
 *
 * Source is the agent's own session log (see src/transcript.mjs), so this is the
 * real exchange — including tool calls and their results — not a reading of
 * whatever the terminal happened to be showing.
 */
export function Conversation({ transcript, paneLabel }) {
  const { entries, meta, hasMore, error, loading, loadOlder, reload, unavailable } = transcript;
  const [openTools, setOpenTools] = useState({});

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted">
        <p>Cannot read this agent’s conversation.</p>
        <p className="text-[12px]">{error.message}</p>
        <button type="button" onClick={() => reload()} className="h-10 rounded-xl border border-line bg-raised px-4 text-fg">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-3">
      {hasMore ? (
        <button
          type="button"
          onClick={loadOlder}
          disabled={loading}
          className="mx-auto mb-3 h-9 rounded-lg border border-line bg-raised px-3 text-[12px] text-muted"
        >
          Load older messages
        </button>
      ) : null}

      {entries.length === 0 && !loading ? (
        <p className="m-auto max-w-xs text-center text-sm text-muted">
          {unavailable === 'file-missing'
            ? 'The agent has not written its session file yet. Send a message below and the conversation appears here.'
            : 'No messages yet in this session. Write below to start it.'}
        </p>
      ) : null}

      <ol className="flex flex-col gap-3">
        {entries.map((entry, index) => (
          <li key={`${entry.kind}-${index}`}>
            {entry.kind === 'user' ? <UserBubble text={entry.text} /> : null}
            {entry.kind === 'assistant' ? (
              <AssistantBlock
                entry={entry}
                openTools={openTools}
                setOpenTools={setOpenTools}
                label={paneLabel}
              />
            ) : null}
            {entry.kind === 'result' ? <OrphanResult entry={entry} /> : null}
          </li>
        ))}
      </ol>

      {loading ? <p className="mt-3 text-center text-[11px] text-muted">syncing…</p> : null}
      {meta?.model ? (
        <p className="mt-4 text-center text-[11px] text-muted">
          {[meta.provider, meta.model].filter(Boolean).join(' / ')}
        </p>
      ) : null}
    </div>
  );
}

function UserBubble({ text }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 700;
  const shown = long && !expanded ? `${text.slice(0, 700)}…` : text;

  return (
    <div className="ml-6 rounded-2xl rounded-br-md border border-accent/40 bg-accent/10 px-3 py-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-accent">you</div>
      <p className="m-0 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{shown}</p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-[11px] text-accent underline"
        >
          {expanded ? 'show less' : `show all (${text.length} chars)`}
        </button>
      ) : null}
    </div>
  );
}

function AssistantBlock({ entry, openTools, setOpenTools, label }) {
  const [showThinking, setShowThinking] = useState(false);

  return (
    <div className="mr-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span>{(label || 'agent').slice(0, 24)}</span>
        {entry.ts ? <span className="font-normal normal-case opacity-70">{timeOf(entry.ts)}</span> : null}
        {entry.model ? <span className="font-normal normal-case opacity-70">{entry.model}</span> : null}
      </div>

      {entry.thinking ? (
        <div>
          <button
            type="button"
            onClick={() => setShowThinking((value) => !value)}
            className="text-[11px] text-muted underline decoration-dotted"
          >
            {showThinking ? 'hide thinking' : 'show thinking'}
          </button>
          {showThinking ? (
            <p className="mb-0 mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-[12px] italic text-muted">
              {entry.thinking}
            </p>
          ) : null}
        </div>
      ) : null}

      {entry.text ? (
        <p data-testid="assistant-text" className="m-0 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">
          {entry.text}
        </p>
      ) : null}

      {entry.tools?.map((tool) => (
        <ToolCard
          key={tool.id ?? `${tool.name}-${Math.random()}`}
          tool={tool}
          open={Boolean(openTools[tool.id])}
          onToggle={() => setOpenTools((current) => ({ ...current, [tool.id]: !current[tool.id] }))}
        />
      ))}
    </div>
  );
}

function ToolCard({ tool, open, onToggle }) {
  const failed = Boolean(tool.error);
  return (
    <div
      className={`rounded-xl border bg-surface ${failed ? 'border-bad/50' : 'border-line'}`}
      data-testid="tool-card"
    >
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
        <span className={`font-mono text-[11px] ${failed ? 'text-bad' : 'text-accent'}`}>⚒ {tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{firstLine(tool.input)}</span>
        {tool.durationMs !== undefined ? (
          <span className="shrink-0 text-[10px] text-muted">{Math.round(tool.durationMs)}ms</span>
        ) : null}
        <span className="shrink-0 text-[10px] text-muted">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="border-t border-line px-2.5 py-2">
          {tool.input ? (
            <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">
              {tool.input}
            </pre>
          ) : null}
          {tool.output ? (
            <pre
              className={`m-0 mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] ${
                failed ? 'text-bad' : 'text-fg'
              }`}
            >
              {tool.output}
            </pre>
          ) : (
            <p className="m-0 mt-2 text-[11px] text-muted">no result recorded</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function OrphanResult({ entry }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-2.5 py-2">
      <div className="font-mono text-[11px] text-accent">⚒ {entry.toolName} result</div>
      <pre className="m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">
        {entry.output}
      </pre>
    </div>
  );
}

function firstLine(text) {
  if (!text) return '';
  const line = String(text).split('\n').find((candidate) => candidate.trim()) ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

function timeOf(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
