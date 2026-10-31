import { liveLogBody } from '../../acp/live-output';
import { LiveSample } from '../../live/live.hub';
import { LaunchView } from './run-view.types';

export function liveVisit(
  key: string,
  step: string,
  root: string,
  previousAttempt: number,
  startedAt: string,
  samples: LiveSample[] = [],
) {
  const body = liveLogBody(root, key, step);
  const started = Date.parse(startedAt);
  return {
    id: -1,
    attempt: previousAttempt + 1,
    status: 'running',
    model: null,
    mode: null,
    durationMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    cpuAvg: 0,
    cpuPeak: 0,
    memAvg: 0,
    memPeak: 0,
    killReason: null,
    decision: null,
    documents: [{ kind: 'log', attempt: previousAttempt + 1, body: body || 'waiting for output\n', createdAt: new Date().toISOString() }],
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
