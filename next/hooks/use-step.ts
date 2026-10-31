'use client';

import { useEffect, useRef, useState } from 'react';
import { api, runLog } from '../lib/api';
import { liveSocket } from '../lib/live';
import { liveLogStep } from '../lib/phases';
import { fileView, LiveUsage, withFileUsage, withLog } from '../lib/step-view';
import { StepView } from '../lib/types';

export function useStep(runKey: string, step: string, live: boolean, revision: string, attempts: number) {
  const [view, setView] = useState<StepView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const follow = useRef(true);
  const latestLog = useRef<{ body: string; samples: StepView['visits'][number]['samples']; usage?: LiveUsage } | null>(null);

  useEffect(() => {
    follow.current = true;
    setView(null);
    setAttempt(0);
    setError(null);
  }, [runKey, step]);

  useEffect(() => {
    let stopped = false;
    latestLog.current = null;
    if (live) {
      follow.current = true;
    }
    api<StepView>(`/runs/${encodeURIComponent(runKey)}/steps/${encodeURIComponent(step)}`)
      .then((body) => {
        if (stopped) {
          return;
        }
        const running = body.visits.at(-1)?.status === 'running';
        const liveLog = latestLog.current;
        if (!running && !liveLog) {
          latestLog.current = null;
        }
        const fetched = running ? withFileUsage(body) : body;
        setView(liveLog ? withLog(fetched, liveLog.body, liveLog.samples, liveLog.usage) : fetched);
        setAttempt((current) => (follow.current ? Math.max(body.visits.length - 1, 0) : current));
        setError(null);
      })
      .catch(async (cause: unknown) => {
        if (stopped) {
          return;
        }
        if (step.startsWith('code-review-')) {
          try {
            const raw = await runLog(runKey, step);
            if (raw !== null) {
              const fetched = withFileUsage(fileView(step, raw));
              setView(fetched);
              setAttempt(0);
              setError(null);
              return;
            }
          } catch {
            // nest will serve this step after it is rebuilt
          }
        }
        setError(cause instanceof Error ? cause.message : 'step failed');
      });
    return () => {
      stopped = true;
    };
  }, [runKey, step, live, revision, attempts]);

  useEffect(() => {
    const socket = liveSocket();
    const apply = (entry: { key: string; step: string; body: string; samples?: StepView['visits'][number]['samples']; usage?: LiveUsage }): void => {
      if (entry.key !== runKey || !liveLogStep(entry.step, step)) {
        return;
      }
      const samples = entry.samples ?? [];
      latestLog.current = { body: entry.body, samples, usage: entry.usage };
      setView((current) => (current ? withLog(current, entry.body, samples, entry.usage) : current));
    };
    socket.on('log', apply);
    return () => {
      socket.off('log', apply);
    };
  }, [runKey, step]);

  useEffect(() => {
    if (!live) {
      return;
    }
    follow.current = true;
    if (!view) {
      return;
    }
    const last = Math.max(view.visits.length - 1, 0);
    setAttempt((current) => (current === last ? current : last));
  }, [live]);

  useEffect(() => {
    if (!follow.current || !view) {
      return;
    }
    const last = Math.max(view.visits.length - 1, 0);
    setAttempt((current) => (current === last ? current : last));
  }, [view]);

  return { view, attempt, setAttempt, error, follow };
}
