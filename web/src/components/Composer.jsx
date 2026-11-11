import { useEffect, useRef, useState } from 'react';

export const KEYS = [
  ['Esc', 'Escape'],
  ['Ctrl-C', 'ctrl+c'],
  ['Tab', 'Tab'],
  ['↑', 'Up'],
  ['↓', 'Down'],
  ['⏎', 'Enter'],
  ['y', 'y'],
  ['n', 'n'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
];

/**
 * Reply box plus the key strip. Text is reviewable before it is sent, and Send
 * submits with Enter in one herdr request; Type only is for drafting.
 */
export function Composer({ disabled, onSend, onKey, choices = [], hint = '', onChoice = () => {} }) {
  const [text, setText] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!disabled) inputRef.current?.focus({ preventScroll: true });
  }, [disabled]);

  const submit = (withEnter) => {
    const value = text;
    if (!value.trim()) return;
    setText('');
    onSend(value, withEnter);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-line bg-surface p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {hint ? <p data-testid="menu-hint" className="m-0 px-1 text-[11px] text-muted">{hint}</p> : null}
      {choices.length ? (
        <div className="flex gap-2">
          {choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              disabled={disabled}
              onClick={() => onChoice(choice.keys)}
              className="h-11 flex-1 rounded-xl border border-accent/60 bg-accent/10 font-semibold text-accent disabled:opacity-40"
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {KEYS.map(([label, key]) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => onKey([key])}
            className="h-9 shrink-0 rounded-lg border border-line bg-raised px-2.5 font-mono text-[13px] disabled:opacity-40"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex items-stretch gap-2">
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit(true);
            }
          }}
          placeholder="Reply to this pane…"
          className="max-h-[30vh] min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-line bg-bg px-3 py-2.5 text-[15px] outline-none focus:border-accent disabled:opacity-40"
        />
        <div className="flex shrink-0 flex-col gap-1.5">
          <button
            type="button"
            disabled={disabled || !text.trim()}
            onClick={() => submit(true)}
            className="min-h-11 flex-1 rounded-xl bg-accent px-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            Send ⏎
          </button>
          <button
            type="button"
            disabled={disabled || !text.trim()}
            onClick={() => submit(false)}
            title="Type the text without pressing Enter"
            className="min-h-11 flex-1 rounded-xl border border-line bg-raised px-3 text-sm disabled:opacity-40"
          >
            Type only
          </button>
        </div>
      </div>
    </div>
  );
}
