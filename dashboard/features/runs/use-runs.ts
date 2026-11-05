'use client';

import { useEffect, useState } from 'react';
import { listRuns, removeRun as deleteRun } from '../../lib/endpoints';
import { useLiveActions, useLiveBridge } from '../shell';
import type { RunSummary } from '@contract/api';

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

  const running = runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!running) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  async function removeRun(key: string): Promise<void> {
    await deleteRun(key);
    setRuns((current) => current.filter((run) => run.key !== key));
  }

  return { runs, now, error, connected, removeRun };
}
