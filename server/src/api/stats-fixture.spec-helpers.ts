import type { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { AgentExchangeEntity, DocumentEntity, LoopEventEntity, RunEntity, StepStatEntity } from '../history/entities';
import { ServerStallEntity } from '../history/server-stall.entities';

/** The fixed time the stats fixture is seeded and read at. */
export const STATS_NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

const DAY_MS = 86_400_000;
const RUNS = 500;
const STEPS_PER_RUN = 30;
const EXCHANGES = 1_000;
const PROMPT_CHARS = 13_000;
const DOCUMENT_CHARS = 17_000;
const CHUNK = 50;
const STATUSES = ['done', 'done', 'done', 'failed', 'blocked', 'active', 'done'];
const STEPS = ['implement', 'checks', 'code-review', 'code-review-security', 'code-review-tests'];
const MODELS = ['model-a', 'model-b', 'model-c'];
const EFFORTS = ['low', 'medium', 'high', null];

function filler(chars: number, seed: number): string {
  const line = `Line ${seed}: the quick brown fox jumps over the lazy dog, again and again.\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Builds and inserts `count` rows a chunk at a time, so no large row list is held while the database fills. */
async function insertInChunks<T extends ObjectLiteral>(
  data: DataSource,
  target: EntityTarget<T>,
  count: number,
  build: (index: number) => Record<string, unknown>,
): Promise<void> {
  for (let at = 0; at < count; at += CHUNK) {
    const rows = Array.from({ length: Math.min(CHUNK, count - at) }, (_, offset) => build(at + offset));
    await data
      .createQueryBuilder()
      .insert()
      .into(target)
      .values(rows as never)
      .execute();
  }
}

function runRow(index: number): Record<string, unknown> {
  const createdAt = STATS_NOW - Math.floor(((RUNS - index) / RUNS) * 60 * DAY_MS);
  const status = STATUSES[index % STATUSES.length];
  const merged = status === 'done' && index % 2 === 0;
  const closed = status === 'done' && !merged;
  const doneAt = createdAt + 3_600_000;
  return {
    key: `f${index}-fixture`,
    status,
    currentStep: status === 'done' ? 'done' : 'implement',
    runtime: index % 3 === 0 ? 'codex' : 'claude',
    codeHost: 'github',
    createdAt: iso(createdAt),
    updatedAt: iso(createdAt),
    prompt: `# Task ${index} *prompt* [link](http://x)\n${filler(PROMPT_CHARS, index)}`,
    title: index % 5 === 0 ? `Stored title ${index}` : null,
    state: merged ? 'merged' : closed ? 'closed' : null,
    mergeOutcome: merged
      ? JSON.stringify({ merged: { repo: { at: iso(doneAt + 600_000) } } })
      : closed
        ? '{"closed":true}'
        : null,
    doneAt: merged || closed ? iso(doneAt) : null,
    parentRunId: index % 11 === 10 ? index - 9 : null,
  };
}

function stepRow(row: number): Record<string, unknown> {
  const index = Math.floor(row / STEPS_PER_RUN);
  const at = row % STEPS_PER_RUN;
  const started = STATS_NOW - Math.floor(((RUNS - index) / RUNS) * 60 * DAY_MS) + at * 120_000;
  return {
    runId: index + 1,
    step: STEPS[at % STEPS.length],
    attempt: Math.floor(at / STEPS.length) + 1,
    runtime: at % 7 === 0 ? null : index % 3 === 0 ? 'codex' : 'claude',
    model: at % 9 === 0 ? null : MODELS[(index + at) % MODELS.length],
    effort: EFFORTS[(index + at) % EFFORTS.length],
    startedAt: iso(started),
    stepStartedAt: at % 4 === 0 ? iso(started - 5_000) : null,
    finishedAt: iso(started + 90_000),
    durationMs: 60_000 + at * 1_000,
    status: at % 13 === 12 ? 'failed' : 'done',
    killReason: at % 13 === 12 ? 'timeout' : null,
    tokensIn: 1_000 + at * 10,
    tokensOut: 200 + at,
    usd: 0.01 * (at + 1),
    shellEdits: at % 5,
  };
}

/** The `n`th exchange sits on the `n`th code-review step row: the third of each run of five rows. */
function exchangeRow(n: number): Record<string, unknown> {
  const started = STATS_NOW - n * 60_000;
  return {
    stepStatId: n * STEPS.length + 3,
    model: 'model-a',
    startedAt: iso(started),
    finishedAt: iso(started + 30_000),
    durationMs: 30_000 + (n % 17) * 1_000,
    requestText: 'request',
    responseText: 'response',
  };
}

function requirementRow(row: number): Record<string, unknown> {
  const index = Math.floor(row / 3);
  const version = row % 3;
  const body =
    version === 2 && index % 2 === 0
      ? { tickets: [{ key: `KEY-${index}`, summary: `Summary ${index}` }], prompt: filler(DOCUMENT_CHARS, index) }
      : { prompt: `## Heading ${index}.${version}\n${filler(DOCUMENT_CHARS, version)}` };
  return {
    runId: index + 1,
    stepStatId: index * STEPS_PER_RUN + 1,
    kind: 'requirements',
    attempt: version + 1,
    body: JSON.stringify(body),
    path: 'requirements.json',
    createdAt: iso(STATS_NOW - (RUNS - index) * 1_000 + version),
  };
}

/** Seeds 500 runs, 15 000 steps, 1 000 code-review exchanges and 1 500 requirements documents. Same rows on every call. */
export async function seedStatsFixture(data: DataSource): Promise<void> {
  await insertInChunks(data, RunEntity, RUNS, runRow);
  await insertInChunks(data, StepStatEntity, RUNS * STEPS_PER_RUN, stepRow);
  await insertInChunks(data, AgentExchangeEntity, EXCHANGES, exchangeRow);
  await insertInChunks(data, DocumentEntity, RUNS * 3, requirementRow);
  await insertInChunks(data, LoopEventEntity, 40, (index) => ({
    runId: (index % RUNS) + 1,
    counter: index % 2 === 0 ? 'review' : 'implement',
    attempt: 1,
    reason: index % 2 === 0 ? 'code-review-security, code-review-tests' : 'required checks failed',
    detail: null,
    createdAt: iso(STATS_NOW - index * 3_600_000),
  }));
  await insertInChunks(data, ServerStallEntity, 5, (index) => ({
    startedAt: iso(STATS_NOW - index * DAY_MS),
    durationMs: 11_000 + index * 1_000,
    kind: index % 2 === 0 ? 'server-blocked' : 'host-paused',
    runningAgents: 1,
    runningChecks: 0,
    runningSetups: 0,
    cpuPercent: 10,
    memoryBytes: 1_000,
  }));
  const seeded = await data
    .createQueryBuilder()
    .select('COUNT(*)', 'runs')
    .from(RunEntity, 'run')
    .getRawOne<{ runs: number }>();
  if (seeded?.runs !== RUNS) {
    throw new Error(`The stats fixture seeded ${seeded?.runs} runs, not ${RUNS}`);
  }
}
