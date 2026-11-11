import { useEffect, useRef } from 'react';

/** A one-field modal. Resolves with the text, or null when cancelled. */
export function PromptDialog({ open, title, hint, initialValue = '', confirmLabel = 'OK', onResolve }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const valueRef = useRef(initialValue);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      valueRef.current = initialValue;
      if (inputRef.current) inputRef.current.value = initialValue;
      dialog.showModal();
      setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialValue]);

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onResolve(null)}
      className="w-[min(420px,92vw)] rounded-2xl border border-line bg-surface p-4 text-fg backdrop:bg-black/55"
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onResolve(valueRef.current);
        }}
      >
        <h2 className="mb-1 text-base font-semibold">{title}</h2>
        {hint ? <p className="mb-3 text-[13px] text-muted">{hint}</p> : null}
        <input
          ref={inputRef}
          defaultValue={initialValue}
          onChange={(event) => {
            valueRef.current = event.target.value;
          }}
          className="h-11 w-full rounded-xl border border-line bg-bg px-3 text-fg outline-none focus:border-accent"
        />
        <menu className="mt-4 flex justify-end gap-2 p-0">
          <button
            type="button"
            onClick={() => {
              dialogRef.current?.close();
              onResolve(null);
            }}
            className="h-11 rounded-xl border border-line bg-raised px-4 text-sm"
          >
            Cancel
          </button>
          <button type="submit" className="h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-white">
            {confirmLabel}
          </button>
        </menu>
      </form>
    </dialog>
  );
}

/** The pane action sheet. */
export function ActionDialog({ open, onAction, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const actions = [
    ['rename', 'Rename pane'],
    ['split-right', 'Split right'],
    ['split-down', 'Split down'],
    ['load-more', 'Load older output'],
    ['new-tab', 'New tab here'],
    ['focus', 'Show in terminal'],
    ['close', 'Close pane', 'danger'],
  ];

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="w-[min(420px,92vw)] rounded-2xl border border-line bg-surface p-4 text-fg backdrop:bg-black/55"
    >
      <h2 className="mb-3 text-base font-semibold">Pane actions</h2>
      <div className="flex flex-col gap-2">
        {actions.map(([id, label, tone]) => (
          <button
            key={id}
            type="button"
            onClick={() => onAction(id)}
            className={`h-11 rounded-xl border border-line bg-raised px-3 text-left text-sm ${
              tone === 'danger' ? 'text-bad' : 'text-fg'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <menu className="mt-4 flex justify-end p-0">
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="h-11 rounded-xl border border-line bg-raised px-4 text-sm"
        >
          Close
        </button>
      </menu>
    </dialog>
  );
}
