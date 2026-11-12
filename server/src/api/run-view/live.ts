import { stepOutput } from '../../core/attempt-output';
import type { HistoryView, LaunchView, VisitView } from '../../contract/api';
import type { LoopEventEntity } from '../../history/entities';
import { readLoopDetail } from '../../history/loop-detail';
import type { LiveSample } from '../../contract/live';
import { liveVisitKey } from '../../contract/visit-key';
import { textSize } from '../run-queries-log';

export function liveVisit(
  key: string,
  step: string,
  root: string,
  attemptId: string | null,
  previousAttempt: number,
  startedAt: string,
  now: number,
  samples: LiveSample[] = [],
): VisitView {
  const body = stepOutput(root, key, step, attemptId) || 'waiting for output\n';
  const started = Date.parse(startedAt);
  return {
    id: -1,
    key: liveVisitKey(step, previousAttempt + 1),
    attempt: previousAttempt + 1,
    status: 'running',
    model: null,
    mode: null,
    durationMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    cpuAvg: 0,
    cpuPeak: 0,
    memAvg: 0,
    memPeak: 0,
    killReason: null,
    decision: null,
    attemptId,
    ...textSize(body),
    documents: [
      {
        kind: 'log',
        attempt: previousAttempt + 1,
        body,
        createdAt: new Date(now).toISOString(),
      },
    ],
    exchanges: [],
    samples,
  };
}

export function launchView(row: { phases: string; fromStep: string | null; createdAt: string }): LaunchView {
  let phases: string[] = [];
  try {
    const parsed = JSON.parse(row.phases) as unknown;
    phases = Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter((item): item is string => typeof item === 'string')
              .map((item) => (item === 'merge-request' ? 'ci' : item)),
          ),
        ]
      : [];
  } catch {
    phases = [];
  }
  return { phases, fromStep: row.fromStep, createdAt: row.createdAt };
}

/** A return of the history; `ciOnly` only when CI failed where the checks had passed. */
export function loopView(loop: LoopEventEntity): HistoryView['loops'][number] {
  const { counter, attempt, reason, createdAt } = loop;
  return {
    counter,
    attempt,
    reason,
    ...(readLoopDetail(loop.detail).ciOnly ? { ciOnly: true as const } : {}),
    createdAt,
  };
}
