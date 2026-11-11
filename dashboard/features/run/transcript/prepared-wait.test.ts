import { describe, expect, it } from 'vitest';
import type { StepEvent } from '@contract/step-events';
import { commandEvents, stepEvent } from '../../../test/step-events';
import { slowestBeforeAttempt } from './prepared-wait';

const agent = {
  runtime: 'claude',
  model: 'opus',
  mode: 'agent',
  tools: 'write' as const,
  timeLimitMs: 1000,
  session: 'fresh' as const,
};

describe('slowestBeforeAttempt', () => {
  const at = (event: StepEvent, occurredAt: string): StepEvent => ({ ...event, occurredAt });
  const finishedIn = (event: StepEvent, durationMs: number): StepEvent =>
    event.kind === 'command.finished' ? { ...event, durationMs } : event;

  it('names the slowest command that started in the wait before the attempt, and no other', () => {
    const [slowStart, slowEnd] = commandEvents(2, 'a', { executable: 'git', args: ['add', '-A'] }, { step: 'checks' });
    const [oldStart, oldEnd] = commandEvents(4, 'b', { executable: 'git', args: ['log'] }, { step: 'checks' });
    const events = [
      at(oldStart, '2026-01-01T00:00:00.000Z'),
      finishedIn(oldEnd, 900_000),
      at(slowStart, '2026-01-01T00:10:00.000Z'),
      finishedIn(slowEnd, 330_000),
      at(
        stepEvent(6, { kind: 'attempt.started', stepKind: 'agent', agent }, { attemptId: 'next' }),
        '2026-01-01T00:15:38.000Z',
      ),
    ];

    expect(slowestBeforeAttempt(events, 'next', 338_000)).toEqual({ command: 'git add -A', ms: 330_000 });
  });

  it('is null when the attempt has no first event', () => {
    expect(slowestBeforeAttempt([], 'next', 338_000)).toBeNull();
  });
});
