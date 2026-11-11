import { useEffect, useRef, useState } from 'react';
import { tailPath } from '../lib/domain.js';
import { Composer } from './Composer.jsx';
import { Conversation } from './Conversation.jsx';
import { MenuChooser } from './MenuChooser.jsx';
import { TerminalView } from './TerminalView.jsx';
import { useTranscript } from '../hooks/useTranscript.js';
import { StatusChip } from './PaneRow.jsx';

/** Which rendered row the tap landed on, so a menu row can be chosen by touch. */
function rowFromPoint(container, x, y) {
  let offset = null;
  if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(x, y);
    if (position && position.offsetNode !== container && container.contains(position.offsetNode)) {
      offset = position.offset;
    }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y);
    if (range && range.startContainer !== container && container.contains(range.startContainer)) {
      offset = range.startOffset;
    }
  }
  if (offset === null) return null;

  const value = container.textContent ?? '';
  let row = 0;
  for (let index = 0; index < offset && index < value.length; index += 1) {
    if (value[index] === '\n') row += 1;
  }
  return row;
}

/** The open pane: header, live text, reply box. */
export function PaneDetail({
  pane,
  paneMissing,
  text,
  error,
  workspace,
  menu,
  onBack,
  onSend,
  onKey,
  onMenu,
  onTapRow,
  onChoice,
}) {
  const outputRef = useRef(null);
  const [stick, setStick] = useState(true);
  // The terminal tab is a real terminal fed by herdr's frame stream; the polled
  // text only takes over when that bridge is missing on this host.
  const [termState, setTermState] = useState('connecting');
  const [termScreen, setTermScreen] = useState('');
  // The agent's own log is the default view when herdr reports one; the raw
  // screen stays one tap away for menus, approvals and anything unparsed.
  const hasTranscript = Boolean(pane?.agent_session);
  const [tab, setTab] = useState(null);
  const activeTab = tab ?? (hasTranscript ? 'conversation' : 'terminal');
  useEffect(() => {
    setTab(null);
    setTermState('connecting');
    setTermScreen('');
  }, [pane?.id]);

  const transcript = useTranscript(pane?.id, {
    enabled: hasTranscript,
    agentStatus: pane?.agent_status,
  });

  // Follow the tail until the reader scrolls away; then leave them alone.
  useEffect(() => {
    const node = outputRef.current;
    if (!node || !stick) return;
    node.scrollTop = node.scrollHeight;
  }, [text, stick, termState]);

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

      {hasTranscript ? (
        <div role="tablist" aria-label="Pane view" className="flex gap-1 border-b border-line bg-surface px-2 py-1">
          {[
            ['conversation', '对话'],
            ['terminal', '终端'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => setTab(id)}
              className={`h-8 rounded-lg px-3 text-[12px] ${
                activeTab === id ? 'bg-raised font-semibold text-fg' : 'text-muted'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {activeTab === 'conversation' && hasTranscript ? (
        <Conversation transcript={transcript} paneLabel={pane.title || pane.agent} />
      ) : null}

      {activeTab === 'terminal' ? (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {termState === 'unavailable' ? (
            <>
              <pre
                ref={outputRef}
                onScroll={onScroll}
                onClick={(event) => {
                  // Selecting text to copy must win over choosing a menu row.
                  if (!window.getSelection()?.isCollapsed) return;
                  const row = rowFromPoint(event.currentTarget, event.clientX, event.clientY);
                  if (row !== null) onTapRow(row);
                }}
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
            </>
          ) : (
            <>
              <TerminalView paneId={pane.id} onScreen={setTermScreen} onState={setTermState} />
              {/* The same screen as text, so menus stay tappable and nothing has
                  to guess what is drawn: xterm's buffer is the authoritative
                  screen here. */}
              <pre data-testid="terminal-screen" className="sr-only">
                {termScreen}
              </pre>
            </>
          )}
        </div>
      ) : null}

      <MenuChooser menu={menu} onChoose={onTapRow} />

      <Composer
        disabled={false}
        onSend={onSend}
        onKey={onKey}
        choices={menu?.kind === 'confirm' ? [
          { label: 'Yes', keys: [menu.confirm.yes, 'Enter'] },
          { label: 'No', keys: [menu.confirm.no, 'Enter'] },
        ] : []}
        hint={
          menu?.kind === 'list'
            ? '' // the chooser above already lists the options
            : menu?.kind === 'confirm'
              ? `等待确认：${menu.confirm.question.trim().slice(-40)}`
              : ''
        }
        onChoice={onChoice}
      />
    </div>
  );
}
