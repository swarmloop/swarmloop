'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepView } from '@contract/api';
import { getRunLog } from '../../lib/endpoints';

/** The lines the window loads first, and each time the person scrolls up for more. */
export const LOG_CHUNK = 2000;

type Visit = StepView['visits'][number];

interface Loaded {
  attemptId: string;
  /** The first loaded line, 1-based. */
  start: number;
  text: string;
}

/**
 * The log of the visit the window shows, read from the server when the visit is shown: the last lines first, earlier
 * ones on request. A running visit carries its stream, so nothing is read for it.
 */
export function useVisitLog(
  runKey: string,
  step: string,
  visit: Visit | undefined,
): { text: string | null; hasEarlier: boolean; loadEarlier: () => void } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const loading = useRef(false);
  const attemptId = visit && !visit.documents.some((item) => item.kind === 'log') ? visit.attemptId : null;
  const lines = visit?.logLines ?? 0;

  useEffect(() => {
    setLoaded(null);
    if (!attemptId || lines === 0) {
      return;
    }
    let stopped = false;
    const start = Math.max(1, lines - LOG_CHUNK + 1);
    getRunLog(runKey, step, attemptId, { tail: LOG_CHUNK })
      .then((text) => !stopped && setLoaded({ attemptId, start, text: text ?? '' }))
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [runKey, step, attemptId, lines]);

  const current = loaded && loaded.attemptId === attemptId ? loaded : null;
  const loadEarlier = useCallback(() => {
    if (!current || current.start <= 1 || loading.current) {
      return;
    }
    const from = Math.max(1, current.start - LOG_CHUNK);
    loading.current = true;
    getRunLog(runKey, step, current.attemptId, { from, tail: current.start - from })
      .then((text) => setLoaded({ ...current, start: from, text: (text ?? '') + current.text }))
      .catch(() => undefined)
      .finally(() => {
        loading.current = false;
      });
  }, [runKey, step, current]);

  return { text: current?.text ?? null, hasEarlier: (current?.start ?? 1) > 1, loadEarlier };
}
