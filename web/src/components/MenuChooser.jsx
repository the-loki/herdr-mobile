// A native chooser for a menu that the agent drew as text.
//
// Tapping a wrapped line of monospace output is unreliable on a phone, and the
// two-column layout falls apart at 390 px. When a menu is recognised, this
// renders its rows as real buttons: label, description, and which one is
// currently highlighted. Choosing one sends the arrow/digit/space keys that the
// TUI itself expects.
export function MenuChooser({ menu, onChoose, disabled = false }) {
  if (menu?.kind !== 'list') return null;

  const options = menu.options.filter((option) => option.significant);
  if (!options.length) return null;

  return (
    <section
      data-testid="menu-chooser"
      aria-label="Menu in this pane"
      className="border-t border-line bg-surface px-2 pb-1 pt-2"
    >
      <header className="mb-1 flex items-baseline gap-2 px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Choose</span>
        <span className="text-[11px] text-muted">
          {options.length} option{options.length === 1 ? '' : 's'}
          {menu.numbered ? ' · numbered' : ' · tap to move and confirm'}
        </span>
      </header>
      <div className="flex max-h-[38vh] flex-col gap-1 overflow-auto">
        {options.map((option) => (
          <button
            key={`${option.row}-${option.label}`}
            type="button"
            data-testid="menu-option"
            data-row={option.row}
            disabled={disabled}
            onClick={() => onChoose(option.row)}
            className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left disabled:opacity-40 ${
              option.selected ? 'border-accent bg-accent/10' : 'border-line bg-raised'
            }`}
          >
            <span
              aria-hidden="true"
              className={`mt-[2px] shrink-0 text-[11px] leading-4 ${option.selected ? 'text-accent' : 'text-muted'}`}
            >
              {option.checked === undefined ? (option.selected ? '◉' : '○') : option.checked ? '☑' : '☐'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[13px] leading-5">{option.label}</span>
              {option.description ? (
                <span className="block truncate text-[11px] text-muted">{option.description}</span>
              ) : null}
            </span>
            {option.number !== null ? (
              <span className="shrink-0 font-mono text-[11px] text-muted">{option.number}</span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );
}
