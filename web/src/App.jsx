import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { ActionDialog, PromptDialog } from './components/Dialogs.jsx';
import { PaneDetail } from './components/PaneDetail.jsx';
import { PaneList } from './components/PaneList.jsx';
import { useHashPane, useHerdrStream, usePaneText, useSnapshot } from './hooks/useHerdr.js';
import { paneLabel, sortByAttention, workspaceLabel } from './lib/domain.js';

export default function App() {
  const { data, error, reload } = useSnapshot();
  const [paneId, selectPane] = useHashPane();
  const [filter, setFilter] = useState('');
  const [view, setView] = useState(() => (window.matchMedia('(min-width: 768px)').matches ? 'detail' : 'list'));
  const [readMode, setReadMode] = useState({ source: 'visible' });
  const [toast, setToast] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [actionOpen, setActionOpen] = useState(false);
  const [herdrConnected, setHerdrConnected] = useState(true);

  const state = data ?? { workspaces: [], tabs: [], panes: [], agents: [], server: null, focused: {} };
  const pane = useMemo(() => state.panes.find((candidate) => candidate.id === paneId) ?? null, [state.panes, paneId]);

  const connected = useHerdrStream({
    onState: reload,
    onAgent: (frame) => {
      reload();
      if (frame.pane_id === paneId) refresh();
    },
    onHerdr: (frame) => setHerdrConnected(frame.connected !== false),
  });

  const { text, error: paneError, refresh } = usePaneText(paneId, {
    enabled: Boolean(paneId),
    source: readMode.source,
    lines: readMode.lines,
  });

  const say = useCallback((message) => {
    setToast(message);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const ask = useCallback(
    (title, hint, value = '') => new Promise((resolve) => setPrompt({ title, hint, value, resolve })),
    [],
  );

  // A deep link (or the back/forward buttons) selecting a pane should show it;
  // the explicit Back button still wins because it does not change paneId.
  useEffect(() => {
    if (paneId) setView('detail');
    else setView(window.matchMedia('(min-width: 768px)').matches ? 'detail' : 'list');
  }, [paneId]);

  // On a wide screen the detail pane is always visible, so land on whatever
  // needs attention first instead of an empty "pick a pane".
  useEffect(() => {
    if (paneId || !data) return;
    if (!window.matchMedia('(min-width: 768px)').matches) return;
    const first = [...(data.panes ?? [])].sort(sortByAttention)[0];
    if (first) selectPane(first.id, { replace: true });
  }, [paneId, data, selectPane]);

  useEffect(() => {
    const saved = localStorage.getItem('hmw-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  }, []);

  const choose = (id) => {
    setReadMode({ source: 'visible' });
    selectPane(id);
    setView('detail');
  };

  const guarded = async (run, successMessage) => {
    try {
      await run();
      await reload();
      if (successMessage) say(successMessage);
    } catch (caught) {
      say(caught.message);
    }
  };

  const sendText = (value, submit) =>
    guarded(async () => {
      await api.input(paneId, { text: value, submit });
      say(submit ? 'Sent' : 'Typed (not submitted)');
      setTimeout(refresh, 250);
    });

  const sendKeys = (keys) =>
    guarded(async () => {
      await api.keys(paneId, keys);
      setTimeout(refresh, 250);
    });

  const newWorkspace = async () => {
    const label = await ask('New workspace', 'Leave the name empty to let herdr pick one.');
    if (label === null) return;
    const cwd = await ask('Working directory', 'Optional; defaults to herdr’s setting.');
    if (cwd === null) return;
    await guarded(() => api.newWorkspace({ label, cwd }), 'Workspace created');
  };

  const newTab = async (workspaceId) => {
    const label = await ask('New tab', `In ${workspaceLabel(state.workspaces, workspaceId)}.`);
    if (label === null) return;
    await guarded(() => api.newTab(workspaceId, label), 'Tab created');
  };

  const closeWorkspace = async (workspaceId) => {
    if (!window.confirm(`Close “${workspaceLabel(state.workspaces, workspaceId)}” and every pane in it?`)) return;
    await guarded(async () => {
      await api.closeWorkspace(workspaceId);
      if (pane?.workspace_id === workspaceId) selectPane(null);
    }, 'Workspace closed');
  };

  const onAction = async (action) => {
    setActionOpen(false);
    if (action === 'rename') {
      const label = await ask('Rename pane', 'Empty clears the custom title.', pane?.label ?? '');
      if (label === null) return;
      await guarded(() => api.renamePane(paneId, label));
    } else if (action === 'split-right' || action === 'split-down') {
      const direction = action === 'split-right' ? 'right' : 'down';
      const command = await ask('Split pane', `Optional command to run in the new ${direction} pane (for example pi).`);
      if (command === null) return;
      await guarded(() => api.splitPane(paneId, direction, command), command ? `Started ${command}` : 'Pane split');
    } else if (action === 'load-more') {
      const lines = Math.min(2000, (readMode.lines ?? 80) + 200);
      setReadMode({ source: 'recent', lines });
      say(`Showing the last ${lines} lines`);
    } else if (action === 'new-tab') {
      await newTab(pane?.workspace_id);
    } else if (action === 'focus') {
      if (!window.confirm('Move your desktop terminal focus to this pane?')) return;
      await guarded(() => api.focus(paneId), 'Focused in herdr');
    } else if (action === 'close') {
      if (!window.confirm(`Close pane “${pane?.title || pane?.id}”?`)) return;
      await guarded(async () => {
        await api.closePane(paneId);
        selectPane(null);
        setView('list');
      }, 'Pane closed');
    }
  };

  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('hmw-theme', next);
  };

  const banner = error
    ? error.status === 401
      ? 'Not paired with this server. Open the pairing link printed in the herdr plugin pane.'
      : error.message
    : !connected
      ? 'Live updates disconnected. Reconnecting…'
      : !herdrConnected
        ? 'The herdr server is unreachable.'
        : null;

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {banner ? (
        <div className="bg-warn px-3 py-2 text-center text-[13px] text-[#21160a]">{banner}</div>
      ) : null}

      <header className="flex h-13 min-h-13 items-center gap-2 border-b border-line bg-surface px-2">
        <button
          type="button"
          onClick={() => setView('list')}
          aria-label="Show session list"
          className="h-9 w-9 rounded-lg border border-line bg-raised text-lg leading-none md:hidden"
        >
          ☰
        </button>
        <span
          title={connected ? 'live' : 'disconnected'}
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${connected && herdrConnected ? 'bg-ok' : 'bg-bad'}`}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          {pane ? paneLabel(pane) : 'Herdr'}
        </span>
        <button
          type="button"
          onClick={() => {
            reload();
            refresh();
          }}
          aria-label="Refresh"
          className="h-9 w-9 rounded-lg border border-line bg-raised text-lg leading-none"
        >
          ⟳
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          className="h-9 w-9 rounded-lg border border-line bg-raised text-lg leading-none"
        >
          ◐
        </button>
      </header>

      <main className="flex min-h-0 min-w-0 flex-1 md:grid md:grid-cols-[340px_1fr]">
        <aside
          className={`min-h-0 w-full flex-col border-line bg-surface md:flex md:w-auto md:border-r ${
            view === 'detail' ? 'hidden' : 'flex'
          }`}
        >
          <PaneList
            state={state}
            selectedId={paneId}
            filter={filter}
            onFilter={setFilter}
            onSelect={choose}
            onNewWorkspace={newWorkspace}
            onNewTab={newTab}
            onCloseWorkspace={closeWorkspace}
          />
        </aside>

        <section className={`min-h-0 min-w-0 flex-col ${view === 'detail' ? 'flex' : 'hidden'} md:flex`}>
          <PaneDetail
            pane={pane}
            paneMissing={Boolean(paneId && !pane)}
            text={readMode.source === 'recent' && readMode.lines ? `${text}` : text}
            error={paneError}
            workspace={pane ? workspaceLabel(state.workspaces, pane.workspace_id) : ''}
            onBack={() => setView('list')}
            onSend={sendText}
            onKey={sendKeys}
            onMenu={() => setActionOpen(true)}
          />
        </section>
      </main>

      <PromptDialog
        open={Boolean(prompt)}
        title={prompt?.title ?? ''}
        hint={prompt?.hint ?? ''}
        initialValue={prompt?.value ?? ''}
        onResolve={(value) => {
          const resolve = prompt?.resolve;
          setPrompt(null);
          resolve?.(value);
        }}
      />
      <ActionDialog open={actionOpen} onAction={onAction} onClose={() => setActionOpen(false)} />

      {toast ? (
        <div
          data-testid="toast"
          className="pointer-events-none fixed left-1/2 top-16 z-30 -translate-x-1/2 rounded-full border border-line bg-raised px-4 py-2.5 text-[13px] shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
