import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { relative } from 'path';
import type { StepEvent, StepEventBody } from '../contract/step-events';
import { isReadOnlyGit } from '../contract/git-reads';
import type { Clock } from './clock';

const OUTPUT_LINES = 40;

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
  /** The activity the code runs in. Its events name it as their parent. */
  activitySpanId: string | null;
}

const storage = new AsyncLocalStorage<StepEventScope>();

/** Runs `run` inside a scope and waits for its events to be written. `lastSeq` is the last `seq` of the run. */
export async function runInStepScope<T>(
  scope: Omit<StepEventScope, 'sequence' | 'activitySpanId'>,
  lastSeq: number,
  run: () => Promise<T>,
): Promise<T> {
  const sequence: Sequence = { next: lastSeq + 1, tail: Promise.resolve() };
  try {
    return await storage.run({ ...scope, sequence, activitySpanId: null }, run);
  } finally {
    await sequence.tail;
  }
}

/** Wraps a callback so that what it records belongs to the step that is running now, even when a stream calls it later. */
export function bindToStepScope<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void {
  return AsyncLocalStorage.bind(fn);
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
    parentSpanId: scope.activitySpanId,
    ...body,
  } as StepEvent;
  scope.sequence.tail = scope.sequence.tail.then(() => scope.sink(event));
}

/**
 * Runs `fn` as a named activity: the commands and events inside it name it as their parent.
 * `result` words what it came to. A throw finishes the activity as failed and goes on.
 */
export async function runActivity<T>(
  title: string,
  fn: () => Promise<T>,
  result: (value: T) => string = () => '',
): Promise<T> {
  const scope = storage.getStore();
  if (!scope) {
    return fn();
  }
  const spanId = randomUUID();
  const started = scope.clock.now();
  recordStepEvent({ kind: 'activity.started', spanId, title });
  const finish = (line: string, failed: boolean): void =>
    recordStepEvent({
      kind: 'activity.finished',
      spanId,
      title,
      result: line,
      failed,
      durationMs: scope.clock.now() - started,
    });
  try {
    const value = await storage.run({ ...scope, activitySpanId: spanId }, fn);
    finish(result(value), false);
    return value;
  } catch (error) {
    finish(`failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`, true);
    throw error;
  }
}

interface CommandSpec {
  actor: 'server' | 'agent';
  repo: string;
  /** Absolute. The event carries it relative to the root. */
  cwd: string;
  executable: string;
  args: string[];
}

interface CommandOutcome {
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  /** What the command printed. The event keeps its last lines, for a failure or a command that is not a read. */
  output?: string;
}

function keptOutput(spec: CommandSpec, outcome: CommandOutcome): string | null {
  const failed = outcome.exitCode !== 0 || Boolean(outcome.timedOut) || Boolean(outcome.cancelled);
  if (!outcome.output || (!failed && isReadOnlyGit(spec.executable, spec.args))) {
    return null;
  }
  const lines = outcome.output.replace(/\s+$/, '').split('\n');
  return lines.slice(-OUTPUT_LINES).join('\n') || null;
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
      output: keptOutput(spec, outcome),
    });
}
