import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Runs blocked before a block carried its own reason code get the code they read today. Until now the code of a
 * blocked run was worked out from its last error text and its step; from now on it is only read from `state_reason`.
 * This migration is the only reader of that old error text. Everything it matches is a literal copy made at the time
 * of writing, so rewording a message or removing the old reader elsewhere cannot change what these rows get.
 */

/** What a stopped step said. */
const STOP_NOTE = 'Stopped by request. Commits, pushes and merge requests stay: Stop is not a rollback.';

/** Codes a block keeps over anything its error text says. */
const KEPT_CODES = [
  'STOPPED',
  'RESOURCE_UNKNOWN',
  'INPUT_MISSING',
  'SUBTASK_BLOCKED',
  'PARENT_TREE_CONFLICT',
  'LOOP_LIMIT',
  'SPEND_LIMIT',
  'PIPELINE_UNFIXED',
];

/** The phrases of an error text and the code each names, tried in this order. */
const TEXT_CODES: readonly [string, string][] = [
  [STOP_NOTE, 'STOPPED'],
  ['does not fit', 'DID_NOT_FIT'],
  ['failed again on unchanged files after a relaunch', 'CHECK_FAILED'],
  ['CI_LOG_UNAVAILABLE', 'CI_LOG_UNAVAILABLE'],
  ['CI_NOT_RUN', 'CI_NOT_RUN'],
  ['CI_TIMEOUT', 'CI_TIMEOUT'],
  ['TEST_FLAKY', 'TEST_FLAKY'],
];

/** Steps that loop: a block there with no other reason is the loop limit. */
const LOOP_STEPS = ['checks', 'code-review', 'pipeline'];

interface BlockedRow {
  id: number;
  current_step: string;
  state_reason: string | null;
  error: string | null;
}

interface Stored {
  code: string;
  message: string;
}

function readStored(text: string | null): Stored | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    return typeof parsed.code === 'string'
      ? { code: parsed.code, message: typeof parsed.message === 'string' ? parsed.message : '' }
      : null;
  } catch {
    return null;
  }
}

function codeOf(row: BlockedRow, stored: Stored | null): string {
  if (stored && KEPT_CODES.includes(stored.code)) return stored.code;
  const fromText = TEXT_CODES.find(([phrase]) => (row.error ?? '').includes(phrase))?.[1];
  if (fromText) return fromText;
  if (stored && stored.code !== 'BLOCKED') return stored.code;
  return LOOP_STEPS.includes(row.current_step) ? 'LOOP_LIMIT' : 'BLOCKED';
}

export class BlockedCodes1797100000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT id, current_step, state_reason,
              (SELECT body FROM documents WHERE documents.run_id = runs.id AND documents.kind = 'error'
               ORDER BY documents.id DESC LIMIT 1) AS error
       FROM runs WHERE status = 'blocked'`,
    )) as BlockedRow[];
    for (const row of rows) {
      const stored = readStored(row.state_reason);
      if (stored?.code === 'SKIPPED') continue;
      const code = codeOf(row, stored);
      if (stored?.code === code) continue;
      await queryRunner.query(`UPDATE runs SET state_reason = ?, state = ? WHERE id = ?`, [
        JSON.stringify({ code, message: stored?.message ?? 'blocked' }),
        code === 'STOPPED' ? 'stopped' : 'blocked',
        row.id,
      ]);
    }
  }

  async down(): Promise<void> {
    // The old text and step only gave the code a row would have read; what a row stored before cannot be told apart from it, so nothing is restored.
  }
}
