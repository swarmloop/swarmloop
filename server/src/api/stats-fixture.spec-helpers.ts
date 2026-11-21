import type { DataSource } from 'typeorm';
import { AgentExchangeEntity, DocumentEntity, LoopEventEntity, RunEntity, StepStatEntity } from '../history/entities';
import { ServerStallEntity } from '../history/server-stall.entities';

export const FIXTURE_RUNS = 500;
const STEPS_PER_RUN = 30;
const EXCHANGES = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 40;
const PROMPT_BYTES = 13 * 1024;
const REQUIREMENTS_BYTES = 17 * 1024;
const STEPS = ['implement', 'checks', 'code-review', 'code-review-security', 'code-review-quality', 'plan'];
const STATUSES = ['done', 'failed', 'blocked', 'running'];
const RUNTIMES = ['claude', 'codex', 'cursor'];

/** A repeatable pseudo-random number: the same fixture on every run. */
function random(seed: number): number {
  const mixed = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return ((Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35) >>> 0) % 100000) / 100000;
}

function padded(head: string, bytes: number): string {
  return head + '\n' + 'word '.repeat(Math.ceil(bytes / 5));
}

async function insertAll<T extends object>(
  data: DataSource,
  entity: new () => T,
  rows: object[],
  perRow: number,
): Promise<void> {
  const size = Math.max(1, Math.floor(CHUNK / perRow));
  for (let at = 0; at < rows.length; at += size) {
    await data
      .createQueryBuilder()
      .insert()
      .into(entity)
      .values(rows.slice(at, at + size))
      .execute();
  }
}

function runRow(index: number, now: number): Partial<RunEntity> {
  const created = new Date(now - random(index) * 60 * DAY_MS).toISOString();
  const status = STATUSES[index % STATUSES.length];
  const merged = status === 'done' && index % 3 === 0;
  const doneAt = status === 'done' ? new Date(Date.parse(created) + 3_600_000).toISOString() : null;
  return {
    key: `run-${index}`,
    status,
    currentStep: status === 'running' ? 'implement' : 'done',
    runtime: RUNTIMES[index % RUNTIMES.length],
    codeHost: '',
    prompt: padded(index % 7 === 0 ? `# Heading ${index}\n\nBody` : `Task ${index}: change the thing`, PROMPT_BYTES),
    title: index % 5 === 0 ? `Stored title ${index}` : null,
    parentRunId: index % 11 === 0 && index > 0 ? index : null,
    state: merged ? 'merged' : status === 'failed' ? 'closed' : null,
    mergeOutcome: merged
      ? JSON.stringify({ merged: { app: { at: new Date(Date.parse(created) + 7_200_000).toISOString() } } })
      : null,
    doneAt,
    createdAt: created,
    updatedAt: created,
  };
}

function stepRow(runId: number, index: number, created: number): Partial<StepStatEntity> {
  const started = created + index * 60_000;
  const duration = 20_000 + Math.floor(random(runId * 100 + index) * 400_000);
  const step = STEPS[index % STEPS.length];
  return {
    runId,
    step,
    attempt: Math.floor(index / STEPS.length) + 1,
    runtime: index % 4 === 0 ? null : RUNTIMES[(runId + index) % RUNTIMES.length],
    model: index % 3 === 0 ? 'model-a' : 'model-b',
    effort: index % 2 === 0 ? 'high' : null,
    startedAt: new Date(started).toISOString(),
    stepStartedAt: index % 5 === 0 ? null : new Date(started).toISOString(),
    finishedAt: new Date(started + duration).toISOString(),
    durationMs: duration,
    status: index % 13 === 0 ? 'failed' : 'done',
    killReason: index % 13 === 0 ? 'timeout' : null,
    tokensIn: 1000 + index,
    tokensOut: 500 + index,
    usd: 0.01 * (index % 9),
    shellEdits: index % 4,
  };
}

/**
 * A database of 500 runs with 13 KB prompts, 15 000 step rows, 1 000 code-review exchanges and 1 500 requirements
 * documents of 17 KB, spread over the 60 days before `now`. Inserted in chunks through the query builder.
 * `runCount` defaults to 500; a smaller count builds the same rows for its first runs.
 */
export async function seedStatsFixture(data: DataSource, now: number, runCount: number = FIXTURE_RUNS): Promise<void> {
  await insertAll(
    data,
    RunEntity,
    Array.from({ length: runCount }, (_, index) => runRow(index, now)),
    14,
  );
  const runs = await data
    .getRepository(RunEntity)
    .find({ select: { id: true, createdAt: true }, order: { id: 'ASC' } });
  const steps = runs.flatMap((run) =>
    Array.from({ length: STEPS_PER_RUN }, (_, index) => stepRow(run.id, index, Date.parse(run.createdAt))),
  );
  await insertAll(data, StepStatEntity, steps, 18);
  const stored = await data
    .getRepository(StepStatEntity)
    .find({ select: { id: true, runId: true, step: true }, order: { id: 'ASC' } });
  const reviews = stored.filter((step) => step.step === 'code-review').slice(0, EXCHANGES);
  const at = new Date(now).toISOString();
  await insertAll(
    data,
    AgentExchangeEntity,
    reviews.map((step, index): Partial<AgentExchangeEntity> => ({
      stepStatId: step.id,
      model: 'model-a',
      startedAt: at,
      finishedAt: at,
      durationMs: 1000 + index,
      requestText: 'request',
      responseText: 'response',
    })),
    8,
  );
  const firstStep = new Map<number, number>();
  for (const step of stored) {
    if (!firstStep.has(step.runId)) {
      firstStep.set(step.runId, step.id);
    }
  }
  const documents = runs.flatMap((run, index) =>
    [1, 2, 3].map((attempt): Partial<DocumentEntity> => {
      const latest = attempt === 3;
      const body =
        latest && index % 2 === 0
          ? JSON.stringify({
              tickets: [{ key: `T-${index}`, summary: `Ticket ${index}` }],
              pad: 'x'.repeat(REQUIREMENTS_BYTES),
            })
          : JSON.stringify({ prompt: `## Requirements ${index} v${attempt}`, pad: 'x'.repeat(REQUIREMENTS_BYTES) });
      return {
        runId: run.id,
        stepStatId: firstStep.get(run.id) ?? 0,
        kind: 'requirements',
        attempt,
        body,
        path: 'requirements.json',
        createdAt: at,
      };
    }),
  );
  await insertAll(data, DocumentEntity, documents, 8);
  const loops = runs.slice(0, 200).map((run, index): Partial<LoopEventEntity> => ({
    runId: run.id,
    counter: index % 2 === 0 ? 'checks' : 'review',
    attempt: 1,
    reason: 'failed',
    createdAt: at,
  }));
  await insertAll(data, LoopEventEntity, loops, 6);
  await insertAll(
    data,
    ServerStallEntity,
    Array.from({ length: 5 }, (_, index): Partial<ServerStallEntity> => ({
      startedAt: new Date(now - index * DAY_MS).toISOString(),
      durationMs: 12_000 + index,
      kind: index % 2 === 0 ? 'server-blocked' : 'host-paused',
      runningAgents: 1,
      runningChecks: 0,
      runningSetups: 0,
      cpuPercent: 10,
      memoryBytes: 1000,
    })),
    10,
  );
}
