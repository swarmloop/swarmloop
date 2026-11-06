import type { StepEvent, StepEventBody } from '@contract/step-events';

/** A step event of the given body. The attempt and the step are those of a first attempt of `implement`. */
export function stepEvent(
  seq: number,
  body: StepEventBody,
  overrides: Partial<Pick<StepEvent, 'attemptId' | 'step'>> = {},
): StepEvent {
  return {
    payloadVersion: 1,
    eventId: `event-${seq}`,
    runId: 1,
    attemptId: 'attempt-1',
    step: 'implement',
    seq,
    occurredAt: '2026-01-01T00:00:00.000Z',
    parentSpanId: null,
    ...overrides,
    ...body,
  };
}

/** The two events of one command. */
export function commandEvents(
  seq: number,
  spanId: string,
  command: { executable: string; args?: string[]; exitCode?: number | null; output?: string | null },
  overrides: Partial<Pick<StepEvent, 'attemptId' | 'step'>> = {},
): StepEvent[] {
  return [
    stepEvent(
      seq,
      {
        kind: 'command.started',
        spanId,
        actor: 'agent',
        repo: 'swarmloop',
        cwd: 'work/swarmloop',
        executable: command.executable,
        args: command.args ?? [],
      },
      overrides,
    ),
    stepEvent(
      seq + 1,
      {
        kind: 'command.finished',
        spanId,
        exitCode: command.exitCode ?? 0,
        signal: null,
        durationMs: 1500,
        timedOut: false,
        cancelled: false,
        output: command.output ?? null,
      },
      overrides,
    ),
  ];
}
