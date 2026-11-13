import type { StepEvent } from '@contract/step-events';
import { commandLine } from './transcript-problems';

/** The server command that took longest in the `gapMs` before the attempt's first event: what the run waited for between two steps. */
export function slowestBeforeAttempt(
  events: StepEvent[],
  attemptId: string,
  gapMs: number,
): { command: string; ms: number } | null {
  const first = events.find((event) => event.kind === 'attempt.started' && event.attemptId === attemptId);
  if (!first) {
    return null;
  }
  const end = Date.parse(first.occurredAt);
  const start = end - gapMs;
  const ended = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'command.finished') {
      ended.set(event.spanId, event.durationMs);
    }
  }
  let slowest: { command: string; ms: number } | null = null;
  for (const event of events) {
    const at = Date.parse(event.occurredAt);
    const ms = event.kind === 'command.started' ? ended.get(event.spanId) : undefined;
    if (
      event.kind === 'command.started' &&
      ms !== undefined &&
      at >= start &&
      at <= end &&
      (!slowest || ms > slowest.ms)
    ) {
      slowest = { command: commandLine(event), ms };
    }
  }
  return slowest;
}
