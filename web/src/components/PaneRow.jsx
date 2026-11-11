import { statusRank, tailPath } from '../lib/domain.js';

const TONES = {
  blocked: 'bg-bad text-white border-transparent',
  working: 'bg-warn text-[#21160a] border-transparent',
  done: 'text-ok border-ok/40',
  idle: 'text-ok border-ok/40',
};

export function StatusChip({ status }) {
  if (!status) return null; // a pane without an agent has no status to show
  const known = status in TONES;
  return (
    <span
      title={`agent status: ${status ?? 'unknown'}`}
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        known ? TONES[status] : 'border-line bg-bg text-muted'
      }`}
    >
      {known ? status : '?'}
    </span>
  );
}

export function worstStatus(panes) {
  return panes.map((pane) => pane.agent_status ?? 'unknown').sort((a, b) => statusRank(a) - statusRank(b))[0] ?? 'unknown';
}

export function PaneRow({ pane, selected, onSelect }) {
  const meta = [pane.agent, tailPath(pane.cwd)].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      data-pane-id={pane.id}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(pane.id)}
      className={`mb-1 flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors ${
        selected ? 'border-accent bg-raised' : 'border-transparent bg-raised hover:border-line'
      }`}
    >
      {pane.agent ? <StatusChip status={pane.agent_status} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px]">{pane.title || pane.label || pane.agent || tailPath(pane.cwd, 1) || pane.id}</span>
        <span className="block truncate text-[11px] text-muted">{meta || pane.id}</span>
      </span>
    </button>
  );
}
