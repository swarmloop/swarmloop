import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A row with no `state` gets the state its row alone gives. Until now a reader worked it out from the row when the
 * column was empty and a later pass filled it; from now on `storedState` reads only the columns. Everything this
 * migration matches is a literal copy made at the time of writing, so changing the state rules elsewhere cannot
 * change what these rows get.
 */

/** Waiting reasons a stored row keeps as its own. */
const WAITING_CODES = [
  'RUNTIME_LIMIT',
  'GIT_AUTH',
  'STALLED',
  'HOST_UNAVAILABLE',
  'CI_NOT_STARTED',
  'DOCKER_UNAVAILABLE',
  'ASKS_PLANNER',
  'SAME_INPUT',
  'WAITS_FOR_MAIN',
  'SUBTASKS_RUNNING',
  'SUBTASK_WAITING',
];

interface UnfilledRow {
  id: number;
  status: string;
  current_step: string;
  state_reason: string | null;
  merge_outcome: string | null;
  attempts_review: number | null;
  attempts_pipeline: number | null;
  attempts_checks: number | null;
}

interface Reason {
  code: string;
  message: string;
  limit?: unknown;
  retryAt?: string;
  refusedStart?: true;
}

interface Filled {
  state: string;
  reason: Reason | null;
}

function readReason(text: string | null): Reason | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<Reason>;
    return typeof parsed.code === 'string'
      ? {
          code: parsed.code,
          message: String(parsed.message ?? ''),
          ...(parsed.limit ? { limit: parsed.limit } : {}),
          ...(typeof parsed.retryAt === 'string' ? { retryAt: parsed.retryAt } : {}),
          ...(parsed.refusedStart === true ? { refusedStart: true as const } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function doneState(row: UnfilledRow, stored: Reason | null): Filled {
  let state = 'done';
  try {
    const outcome = JSON.parse(row.merge_outcome ?? 'null') as Record<string, unknown> | null;
    if (outcome && 'merged' in outcome) state = 'merged';
    else if (outcome && 'closed' in outcome) state = 'closed';
  } catch {
    // A text that is not an outcome leaves the run done.
  }
  return { state, reason: stored };
}

function waitingState(row: UnfilledRow, stored: Reason | null): Filled {
  if (stored && WAITING_CODES.includes(stored.code)) return { state: 'waiting', reason: stored };
  const returned =
    row.current_step === 'implement' &&
    ((row.attempts_review ?? 0) > 0 || (row.attempts_pipeline ?? 0) > 0 || (row.attempts_checks ?? 0) > 0);
  return returned
    ? { state: 'idle', reason: { code: 'RETURNED', message: 'returned to implement' } }
    : { state: 'idle', reason: null };
}

function filledOf(row: UnfilledRow): Filled {
  const stored = readReason(row.state_reason);
  if (stored?.code === 'SKIPPED') return { state: 'skipped', reason: stored };
  switch (row.status) {
    case 'running':
      return { state: 'running', reason: null };
    case 'done':
      return doneState(row, stored);
    case 'blocked': {
      const code = stored?.code ?? 'BLOCKED';
      return {
        state: code === 'STOPPED' ? 'stopped' : 'blocked',
        reason: { code, message: stored?.message ?? 'blocked' },
      };
    }
    case 'failed':
      return { state: stored?.code === 'STOPPED' ? 'stopped' : 'failed', reason: stored };
    default:
      return waitingState(row, stored);
  }
}

export class RunStateFilled1797700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT id, status, current_step, state_reason, merge_outcome, attempts_review, attempts_pipeline, attempts_checks
       FROM runs WHERE state IS NULL`,
    )) as UnfilledRow[];
    for (const row of rows) {
      const filled = filledOf(row);
      await queryRunner.query(`UPDATE runs SET state = ?, state_reason = ? WHERE id = ?`, [
        filled.state,
        filled.reason ? JSON.stringify(filled.reason) : null,
        row.id,
      ]);
    }
  }

  async down(): Promise<void> {
    // A row filled here cannot be told apart from one that stored the same state, so nothing is restored.
  }
}
