import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { relative } from 'path';
import type { StepEvent, StepEventBody } from '../contract/step-events';
import type { Clock } from './clock';

/** Where the events of one attempt go. Writes run one after the other, in `seq` order. */
interface Sequence {
  next: number;
  tail: Promise<void>;
}

interface StepEventScope {
  runId: number;
  attemptId: string;
  step: StepEvent['step'];
  /** The server root, which a command's cwd is made relative to. */
  root: string;
  clock: Clock;
  /** Stores an event. It must not throw. */
  sink: (event: StepEvent) => Promise<void>;
  sequence: Sequence;
}

const storage = new AsyncLocalStorage<StepEventScope>();

/** Runs `run` inside a scope and waits for its events to be written. `lastSeq` is the last `seq` of the run. */
export async function runInStepScope<T>(
  scope: Omit<StepEventScope, 'sequence'>,
  lastSeq: number,
  run: () => Promise<T>,
): Promise<T> {
  const sequence: Sequence = { next: lastSeq + 1, tail: Promise.resolve() };
  try {
    return await storage.run({ ...scope, sequence }, run);
  } finally {
    await sequence.tail;
  }
}

/** Records an event of the current step. Outside a scope it does nothing. */
export function recordStepEvent(body: StepEventBody): void {
  const scope = storage.getStore();
  if (!scope) {
    return;
  }
  const event = {
    payloadVersion: 1,
    eventId: randomUUID(),
    runId: scope.runId,
    attemptId: scope.attemptId,
    step: scope.step,
    seq: scope.sequence.next++,
    occurredAt: scope.clock.iso(),
    parentSpanId: null,
    ...body,
  } as StepEvent;
  scope.sequence.tail = scope.sequence.tail.then(() => scope.sink(event));
}

interface CommandSpec {
  actor: 'server' | 'agent';
  repo: string;
  /** Absolute. The event carries it relative to the root. */
  cwd: string;
  executable: string;
  args: string[];
  output?: string | null;
}

interface CommandOutcome {
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
}

/** Records `command.started` and returns the function that records `command.finished`. Outside a scope both do nothing. */
export function startCommandSpan(spec: CommandSpec): (outcome: CommandOutcome) => void {
  const scope = storage.getStore();
  if (!scope) {
    return () => undefined;
  }
  const spanId = randomUUID();
  const started = scope.clock.now();
  recordStepEvent({
    kind: 'command.started',
    spanId,
    actor: spec.actor,
    repo: spec.repo,
    cwd: relative(scope.root, spec.cwd) || '.',
    executable: spec.executable,
    args: spec.args,
  });
  return (outcome) =>
    recordStepEvent({
      kind: 'command.finished',
      spanId,
      exitCode: outcome.exitCode,
      signal: outcome.signal ?? null,
      durationMs: scope.clock.now() - started,
      timedOut: outcome.timedOut ?? false,
      cancelled: outcome.cancelled ?? false,
      output: spec.output ?? null,
    });
}
