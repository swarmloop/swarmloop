'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { liveSocket } from '../lib/live';
import { RunSummary } from '../lib/types';

export function useLive() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let stopped = false;
    const load = (): void => {
      api<{ runs: RunSummary[] }>('/runs')
        .then((body) => {
          if (!stopped) {
            setRuns(body.runs);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!stopped) {
            setError(cause instanceof Error ? cause.message : 'api is not reachable');
          }
        });
    };
    load();
    const socket = liveSocket();
    const show = (): void => setConnected(true);
    const hide = (): void => setConnected(false);
    const apply = (body: { runs: RunSummary[] }): void => {
      if (!stopped) {
        setRuns(body.runs);
        setError(null);
      }
    };
    socket.on('connect', show);
    socket.on('disconnect', hide);
    socket.on('runs', apply);
    if (socket.connected) {
      show();
    }
    return () => {
      stopped = true;
      socket.off('connect', show);
      socket.off('disconnect', hide);
      socket.off('runs', apply);
    };
  }, []);

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
    await api(`/runs/${encodeURIComponent(key)}`, { method: 'DELETE' });
    setRuns((current) => current.filter((run) => run.key !== key));
  }

  return { runs, now, error, connected, removeRun };
}
