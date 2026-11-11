import { useEffect, useRef, useState } from 'react';
import { tailPath } from '../lib/domain.js';
import { Composer } from './Composer.jsx';
import { StatusChip } from './PaneRow.jsx';

/** The open pane: header, live text, reply box. */
export function PaneDetail({ pane, paneMissing, text, error, workspace, onBack, onSend, onKey, onMenu }) {
  const outputRef = useRef(null);
  const [stick, setStick] = useState(true);

  // Follow the tail until the reader scrolls away; then leave them alone.
  useEffect(() => {
    const node = outputRef.current;
    if (!node || !stick) return;
    node.scrollTop = node.scrollHeight;
  }, [text, stick]);

  const onScroll = () => {
    const node = outputRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setStick(distance < 24);
  };

  if (!pane) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted">
        <p>{paneMissing ? 'This pane is no longer open in herdr.' : 'Pick a pane to read it and reply.'}</p>
        <button type="button" onClick={onBack} className="h-10 rounded-xl border border-line bg-raised px-4 text-fg">
          Back to the list
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-w-0 items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to list"
          className="h-9 w-9 shrink-0 rounded-lg border border-line bg-raised text-lg leading-none md:hidden"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{pane.title || pane.label || pane.agent || pane.id}</span>
            {pane.agent ? <StatusChip status={pane.agent_status} /> : null}
          </div>
          <div className="truncate text-[11px] text-muted">
            {[workspace, pane.agent, pane.cwd || tailPath(pane.cwd)].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button
          type="button"
          onClick={onMenu}
          aria-label="Pane actions"
          className="h-9 w-9 shrink-0 rounded-lg border border-line bg-raised text-lg leading-none"
        >
          ⋯
        </button>
      </header>

      <div className="relative flex min-h-0 min-w-0 flex-1">
        <pre
          ref={outputRef}
          onScroll={onScroll}
          className="pane-text m-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-[1.35] md:whitespace-pre md:break-normal"
        >
          {error ? `Could not read this pane.\n\n${error.message}` : text || 'Loading…'}
        </pre>
        {!stick ? (
          <button
            type="button"
            onClick={() => {
              const node = outputRef.current;
              setStick(true);
              if (node) node.scrollTop = node.scrollHeight;
            }}
            className="absolute bottom-3 right-3 h-9 rounded-lg border border-line bg-raised px-3 text-[13px]"
          >
            Jump to latest ↓
          </button>
        ) : null}
      </div>

      <Composer disabled={false} onSend={onSend} onKey={onKey} />
    </div>
  );
}
