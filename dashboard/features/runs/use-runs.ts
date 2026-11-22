'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listRuns, removeRun as deleteRun } from '../../lib/endpoints';
import { useLiveActions, useLiveBridge } from '../shell';
import type { RunSummary } from '@contract/api';
import type { PartCounts } from '@contract/run-list';

const WORKING_TICK_MS = 1000;
const IDLE_TICK_MS = 30_000;

export function useRuns(): {
  runs: RunSummary[];
  counts: PartCounts;
  otherMatches: number;
  /** The cursor of the next page of the shown part, or null on the last page. */
  next: string | null;
  /** True while the list of a newly chosen part has not arrived. */
  listing: boolean;
  loadingMore: boolean;
  /** Loads the page after the last one shown; one request at a time. */
  loadMore: () => void;
  loaded: boolean;
  now: number;
  error: string | null;
  connected: boolean;
  /** Lists the runs again after a failed load. */
  retry: () => void;
  removeRun: (key: string) => Promise<void>;
} {
  const runs = useLiveBridge((snapshot) => snapshot.runs);
  const connected = useLiveBridge((snapshot) => snapshot.connected);
  const connects = useLiveBridge((snapshot) => snapshot.connects);
  const loaded = useLiveBridge((snapshot) => snapshot.loaded);
  const counts = useLiveBridge((snapshot) => snapshot.counts);
  const { part, q } = useLiveBridge((snapshot) => snapshot.view);
  const next = useLiveBridge((snapshot) => snapshot.next);
  const otherMatches = useLiveBridge((snapshot) => snapshot.otherMatches);
  const listing = useLiveBridge((snapshot) => snapshot.listing);
  const { setRuns, setPage } = useLiveActions();
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const mounted = useRef(true);
  const loadingMoreNow = useRef(false);

  const fail = useCallback((cause: unknown): void => {
    if (mounted.current) {
      setError(cause instanceof Error ? cause.message : 'api is not reachable');
    }
  }, []);

  const reload = useCallback((): void => {
    setError(null);
    const view = { part, q };
    listRuns(view)
      .then((page) => {
        if (mounted.current) {
          setPage(page, view, false);
        }
      })
      .catch(fail);
  }, [part, q, setPage, fail]);

  const loadMore = (): void => {
    if (next === null || loadingMoreNow.current) {
      return;
    }
    loadingMoreNow.current = true;
    setLoadingMore(true);
    const view = { part, q };
    listRuns({ ...view, cursor: next })
      .then((page) => {
        if (mounted.current) {
          setPage(page, view, true);
        }
      })
      .catch(fail)
      .finally(() => {
        loadingMoreNow.current = false;
        if (mounted.current) {
          setLoadingMore(false);
        }
      });
  };

  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  // Every connect, the first included, may follow missed changes: the shown part and filter are read again.
  const seenConnects = useRef(connects);
  useEffect(() => {
    if (connects > seenConnects.current) {
      reload();
    }
    seenConnects.current = connects;
  }, [connects, reload]);

  // While a filter finds nothing, the hint of how many runs the other part holds follows the counts.
  const countsKey = `${counts.active}/${counts.done}/${counts.all}`;
  const seenCounts = useRef(countsKey);
  useEffect(() => {
    if (seenCounts.current === countsKey) {
      return;
    }
    seenCounts.current = countsKey;
    if (q !== '' && runs.length === 0) {
      reload();
    }
  }, [countsKey, q, runs.length, reload]);

  useEffect(() => {
    setError(null);
  }, [runs]);

  // The time of a working step counts in seconds. With nothing working, the relative times and day headers still move on.
  const running = runs.some((run) => run.status === 'running');
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), running ? WORKING_TICK_MS : IDLE_TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  async function removeRun(key: string): Promise<void> {
    await deleteRun(key);
    setRuns((current) => current.filter((run) => run.key !== key));
  }

  return {
    runs,
    counts,
    otherMatches,
    next,
    listing,
    loadingMore,
    loadMore,
    loaded,
    now,
    error,
    connected,
    retry: reload,
    removeRun,
  };
}
