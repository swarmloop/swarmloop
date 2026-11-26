import type { MigrationInterface, QueryRunner } from 'typeorm';
import { backfillAgentCallLog } from './agent-call-log-backfill';

const NOT_ZERO = 'NOT NULL DEFAULT 0';

const COLUMNS: [string, string][] = [
  ['kind', "text NOT NULL DEFAULT 'call'"],
  ['parent_id', 'integer'],
  ['previous_id', 'integer'],
  ['replaces_id', 'integer'],
  ['run_key', 'text'],
  ['turn_key', 'text'],
  ['backlog', 'text'],
  ['task_slug', 'text'],
  ['epic_key', 'text'],
  ['step', 'text'],
  ['planner_level', 'text'],
  ['purpose', 'text'],
  ['start_reason', 'text'],
  ['attempt_id', 'text'],
  ['chat_idle_min', 'float'],
  ['runtime', 'text'],
  ['effort', 'text'],
  ['usage', 'text'],
  ['prices', 'text'],
  ['ties', 'text'],
  ['input_tokens', `integer ${NOT_ZERO}`],
  ['cache_read_tokens', `integer ${NOT_ZERO}`],
  ['cache_write_tokens', `integer ${NOT_ZERO}`],
  ['output_tokens', `integer ${NOT_ZERO}`],
  ['own_usd', `float ${NOT_ZERO}`],
  ['end_kind', 'text'],
  ['error_class', 'text'],
  ['error_text', 'text'],
  ['exit_code', 'integer'],
  ['limit_window', 'text'],
  ['limit_resets_at', 'text'],
  ['refused_reason', 'text'],
  ['stop_reason', 'text'],
  ['due_at', 'text'],
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS "IDX_agent_exchanges_run_key" ON "agent_exchanges" ("run_key")',
  'CREATE INDEX IF NOT EXISTS "IDX_agent_exchanges_turn_key" ON "agent_exchanges" ("turn_key")',
  'CREATE INDEX IF NOT EXISTS "IDX_agent_exchanges_attempt_id" ON "agent_exchanges" ("attempt_id")',
  `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_agent_exchanges_ping_due" ON "agent_exchanges" ("chat_id", "due_at") WHERE kind = 'ping'`,
];

const INDEX_NAMES = [
  'IDX_agent_exchanges_run_key',
  'IDX_agent_exchanges_turn_key',
  'IDX_agent_exchanges_attempt_id',
  'IDX_agent_exchanges_ping_due',
];

/** `agent_exchanges` becomes the log of every agent call. A database that `synchronize` built has the columns and keeps its rows as they are. */
export class AgentCallLog1797300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const existing = (await queryRunner.query(`PRAGMA table_info("agent_exchanges")`)) as { name: string }[];
    // A database that has the columns was written by code that fills them, so it has nothing to backfill.
    const old = !existing.some((column) => column.name === 'own_usd');
    for (const [name, definition] of COLUMNS) {
      if (!existing.some((column) => column.name === name)) {
        await queryRunner.query(`ALTER TABLE "agent_exchanges" ADD COLUMN "${name}" ${definition}`);
      }
    }
    for (const index of INDEXES) {
      await queryRunner.query(index);
    }
    if (old) {
      await backfillAgentCallLog(queryRunner);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of INDEX_NAMES) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    }
    for (const [name] of COLUMNS) {
      await queryRunner.query(`ALTER TABLE "agent_exchanges" DROP COLUMN "${name}"`);
    }
  }
}
