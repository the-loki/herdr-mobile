import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * The agent's own conversation log for a pane. Read-only and paged: a long
 * session is not downloaded whole, and "load older" is the only way back.
 *
 * The interval follows the agent: fast while it is working, slow when it is not.
 */
export function useTranscript(paneId, { agentStatus, enabled = true } = {}) {
  const [entries, setEntries] = useState([]);
  const [meta, setMeta] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState(undefined);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  const load = useCallback(
    async ({ before } = {}) => {
      if (!paneId || !enabled) return;
      setLoading(true);
      try {
        const page = await api.transcript(paneId, { before, limit: 40 });
        if (!alive.current) return;
        setMeta(page.meta ?? null);
        setUnavailable(page.unavailable ?? null);
        setError(null);
        if (before === undefined) {
          setEntries(page.entries ?? []);
        } else {
          setEntries((current) => [...(page.entries ?? []), ...current]);
        }
        setHasMore(Boolean(page.hasMore));
        setNextBefore(page.nextBefore);
      } catch (caught) {
        if (alive.current) setError(caught);
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [paneId, enabled],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!paneId || !enabled) {
      setEntries([]);
      setMeta(null);
      return undefined;
    }
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, agentStatus === 'working' ? 2000 : 8000);
    return () => clearInterval(interval);
  }, [paneId, enabled, agentStatus, load]);

  return {
    entries,
    meta,
    hasMore,
    nextBefore,
    error,
    unavailable,
    loading,
    reload: load,
    loadOlder: () => load({ before: nextBefore }),
  };
}
