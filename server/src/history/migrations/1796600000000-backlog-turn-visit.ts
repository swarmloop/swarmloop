import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS: { column: string; type: string }[] = [
  { column: 'runtime', type: `text NOT NULL DEFAULT ('')` },
  { column: 'model', type: `text NOT NULL DEFAULT ('')` },
  { column: 'effort', type: 'text' },
  { column: 'tokens_in', type: 'integer NOT NULL DEFAULT (0)' },
  { column: 'tokens_out', type: 'integer NOT NULL DEFAULT (0)' },
  { column: 'usd', type: 'float NOT NULL DEFAULT (0)' },
  { column: 'duration_ms', type: 'integer NOT NULL DEFAULT (0)' },
  { column: 'transcript', type: `text NOT NULL DEFAULT ('')` },
];

/** What a planner turn's agent visit used: runtime, model, effort, tokens, cost, time and the transcript path. A database that `synchronize` built already has the columns. */
export class BacklogTurnVisit1796600000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const present = (await queryRunner.query(`PRAGMA table_info("backlog_turns")`)) as { name: string }[];
    for (const { column, type } of COLUMNS) {
      if (!present.some((existing) => existing.name === column)) {
        await queryRunner.query(`ALTER TABLE "backlog_turns" ADD COLUMN "${column}" ${type}`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const { column } of COLUMNS) {
      await queryRunner.query(`ALTER TABLE "backlog_turns" DROP COLUMN "${column}"`);
    }
  }
}
