'use client';

import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import { getRunLog, getStep } from '../../lib/endpoints';
import { useLiveBridge } from '../shell';
import { liveLogStep } from './phases';
import { fileView, withFileUsage, withLog } from './step-view';
import type { LiveLog, LiveUsage } from '@contract/live';
import type { StepView } from '@contract/api';

export function useStep(
  runKey: string,
  step: string,
  live: boolean,
  revision: string,
  attempts: number,
): {
  view: StepView | null;
  attempt: number;
  setAttempt: Dispatch<SetStateAction<number>>;
  error: string | null;
  follow: RefObject<boolean>;
} {
  const [view, setView] = useState<StepView | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const follow = useRef(true);
  const logs = useLiveBridge((snapshot) => snapshot.logs);
  const seenLogs = useRef(new WeakSet<LiveLog>());
  const latestLog = useRef<{
    body: string;
    samples: StepView['visits'][number]['samples'];
    usage?: LiveUsage;
    /** The attempt the log opened or updated in the view. */
    attempt?: number;
  } | null>(null);

  useEffect(() => {
    follow.current = true;
    setView(null);
    setAttempt(0);
    setError(null);
  }, [runKey, step]);

  useEffect(() => {
    let stopped = false;
    latestLog.current = null;
    logs.forEach((entry) => seenLogs.current.add(entry));
    if (live) {
      follow.current = true;
    }
    getStep(runKey, step)
      .then((body) => {
        if (stopped) {
          return;
        }
        const last = body.visits.at(-1);
        const running = last?.status === 'running';
        // A stored visit that already holds the log's attempt ends it: the log must not open the next attempt.
        const stale = !running && last !== undefined && last.attempt >= (latestLog.current?.attempt ?? Infinity);
        if (stale) {
          latestLog.current = null;
        }
        const liveLog = latestLog.current;
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
            const raw = await getRunLog(runKey, step);
            if (raw !== null) {
              const fetched = withFileUsage(fileView(step, raw));
              setView(fetched);
              setAttempt(0);
              setError(null);
              return;
            }
          } catch {
            // the server will serve this step after it is rebuilt
          }
        }
        setError(cause instanceof Error ? cause.message : 'step failed');
      });
    return () => {
      stopped = true;
    };
  }, [runKey, step, live, revision, attempts]);

  useEffect(() => {
    const fresh = logs.filter((entry) => !seenLogs.current.has(entry));
    fresh.forEach((entry) => seenLogs.current.add(entry));
    const entry = fresh.filter((item) => item.key === runKey && liveLogStep(item.step, step)).at(-1);
    if (!entry) {
      return;
    }
    const samples = entry.samples ?? [];
    latestLog.current = { body: entry.body, samples, usage: entry.usage };
    setView((current) => {
      if (!current) {
        return current;
      }
      const next = withLog(current, entry.body, samples, entry.usage);
      if (latestLog.current) {
        latestLog.current.attempt = next.visits.at(-1)?.attempt;
      }
      return next;
    });
  }, [logs, runKey, step]);

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
