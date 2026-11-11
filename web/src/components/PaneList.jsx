import { useMemo } from 'react';
import { paneLabel, sortByAttention, workspaceLabel } from '../lib/domain.js';
import { PaneRow, StatusChip, worstStatus } from './PaneRow.jsx';

/** Workspaces → tabs → panes, the same nesting herdr shows. */
export function PaneList({ state, selectedId, filter, onFilter, onSelect, onNewWorkspace, onNewTab, onCloseWorkspace }) {
  const groups = useMemo(() => groupPanes(state, filter), [state, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-2 border-b border-line p-2">
        <input
          type="search"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          placeholder="Filter agents and panes"
          className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 text-[14px] outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={onNewWorkspace}
          title="New workspace"
          aria-label="New workspace"
          className="h-10 w-10 shrink-0 rounded-xl border border-line bg-raised text-lg leading-none"
        >
          ＋
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {groups.length === 0 ? (
          <p className="p-2 text-sm text-muted">
            {filter ? 'Nothing matches that filter.' : 'No panes yet. Start one with the ＋ button.'}
          </p>
        ) : null}

        {groups.map(({ workspace, panes, tabs }) => (
          <section key={workspace.id} className="mb-3">
            <header className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              <span className="min-w-0 flex-1 truncate">{workspaceLabel(state.workspaces, workspace.id)}</span>
              {panes.some((pane) => pane.agent) ? <StatusChip status={worstStatus(panes)} /> : null}
              <button
                type="button"
                onClick={() => onNewTab(workspace.id)}
                title="New tab in this workspace"
                aria-label="New tab in this workspace"
                className="h-7 w-7 rounded-lg border border-line bg-raised text-[13px] leading-none"
              >
                ＋
              </button>
              <button
                type="button"
                onClick={() => onCloseWorkspace(workspace.id)}
                title="Close this workspace"
                aria-label="Close this workspace"
                className="h-7 w-7 rounded-lg border border-line bg-raised text-[13px] leading-none"
              >
                ×
              </button>
            </header>

            {tabs.map(({ tab, tabPanes }) => (
              <div key={tab?.id ?? 'none'}>
                {tab?.label && tab.label !== workspace.label && !/^\d+$/.test(tab.label) ? (
                  <div className="px-2 pb-1 text-[11px] text-muted">{tab.label}</div>
                ) : null}
                {tabPanes.map((pane) => (
                  <PaneRow key={pane.id} pane={pane} selected={pane.id === selectedId} onSelect={onSelect} />
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>

      <footer className="border-t border-line px-3 py-1.5 text-[11px] text-muted">
        {state.server ? `herdr ${state.server.version} · protocol ${state.server.protocol}` : 'connecting…'}
        {state.panes.length ? ` · ${state.panes.length} pane${state.panes.length === 1 ? '' : 's'}` : ''}
      </footer>
    </div>
  );
}

function groupPanes(state, filter) {
  const needle = filter.trim().toLowerCase();
  const matches = (pane) => {
    if (!needle) return true;
    return [paneLabel(pane), pane.cwd, pane.agent, pane.id, workspaceLabel(state.workspaces, pane.workspace_id)]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  };

  return [...state.workspaces]
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .map((workspace) => {
      const panes = state.panes.filter((pane) => pane.workspace_id === workspace.id && matches(pane)).sort(sortByAttention);
      const tabIds = [...new Set(panes.map((pane) => pane.tab_id))];
      const tabs = tabIds.map((tabId) => ({
        tab: state.tabs.find((candidate) => candidate.id === tabId) ?? null,
        tabPanes: panes.filter((pane) => pane.tab_id === tabId),
      }));
      return { workspace, panes, tabs };
    })
    .filter((group) => group.panes.length);
}
