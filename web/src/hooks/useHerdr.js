import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/** The server's snapshot is authoritative; SSE only tells us to refetch it. */
export function useSnapshot() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await api.state());
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/**
 * Live event pokes. `onState` fires on anything structural; `onAgent` carries
 * the pane whose agent changed status. Reconnects are the browser's job.
 */
export function useHerdrStream({ onState, onAgent, onHerdr }) {
  const [connected, setConnected] = useState(false);
  const handlers = useRef({ onState, onAgent, onHerdr });
  handlers.current = { onState, onAgent, onHerdr };

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.t === 'state') handlers.current.onState?.();
      else if (frame.t === 'agent') handlers.current.onAgent?.(frame);
      else if (frame.t === 'herdr') handlers.current.onHerdr?.(frame);
    };
    return () => source.close();
  }, []);

  return connected;
}

/**
 * The text of the open pane. herdr gives us no output-change event and its
 * `revision` is a stub, so we poll the visible screen while the tab is visible.
 * Scrollback is never polled: reading `recent` past the viewport makes herdr
 * scroll the operator's own terminal.
 */
export function usePaneText(paneId, { enabled = true, source = 'visible', lines } = {}) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const fetchNow = useCallback(async () => {
    if (!paneId) return;
    const id = ++requestId.current;
    try {
      const data = await api.paneText(paneId, { source, lines });
      if (id !== requestId.current) return;
      setText(data.text ?? '');
      setError(null);
    } catch (caught) {
      if (id !== requestId.current) return;
      setError(caught);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [paneId, source, lines]);

  useEffect(() => {
    if (!paneId || !enabled) return undefined;
    setLoading(true);
    fetchNow();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') fetchNow();
    }, 1200);
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [paneId, enabled, fetchNow]);

  return { text, error, loading, refresh: fetchNow, setText };
}

/** The selected pane id lives in the URL hash so a reload keeps your place. */
export function useHashPane() {
  const [paneId, setPaneId] = useState(() => readHash());

  useEffect(() => {
    const onChange = () => setPaneId(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const select = useCallback((id, { replace = false } = {}) => {
    const hash = id ? `#pane=${encodeURIComponent(id)}` : '';
    if (replace) window.history.replaceState(null, '', hash || window.location.pathname);
    else window.history.pushState(null, '', hash || window.location.pathname);
    setPaneId(id ?? null);
  }, []);

  return [paneId, select];
}

function readHash() {
  const match = /pane=([^&]+)/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}
