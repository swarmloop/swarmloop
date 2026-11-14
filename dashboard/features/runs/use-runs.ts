'use client';

import { useEffect, useState } from 'react';
import { listRuns, removeRun as deleteRun } from '../../lib/endpoints';
import { useLiveActions, useLiveBridge } from '../shell';
import type { RunSummary } from '@contract/api';

const WORKING_TICK_MS = 1000;
const IDLE_TICK_MS = 30_000;

export function useRuns(): {
  runs: RunSummary[];
  now: number;
  error: string | null;
  connected: boolean;
  removeRun: (key: string) => Promise<void>;
} {
  const runs = useLiveBridge((snapshot) => snapshot.runs);
  const connected = useLiveBridge((snapshot) => snapshot.connected);
  const { setRuns } = useLiveActions();
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    listRuns()
      .then((body) => {
        if (!stopped) {
          setRuns(body.runs);
        }
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : 'api is not reachable');
        }
      });
    return () => {
      stopped = true;
    };
  }, [setRuns]);

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

  return { runs, now, error, connected, removeRun };
}
