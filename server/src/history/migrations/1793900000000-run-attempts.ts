import type { MigrationInterface, QueryRunner } from 'typeorm';

async function addColumn(queryRunner: QueryRunner, table: string, column: string, definition: string): Promise<void> {
  const columns = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as { name: string }[];
  if (!columns.some((existing) => existing.name === column)) {
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

/** Attempt ids and a revision for the atomic claim and the atomic finalize of a step. A database that `synchronize` built already has them. */
export class RunAttempts1793900000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await addColumn(queryRunner, 'runs', 'revision', 'integer NOT NULL DEFAULT (0)');
    await addColumn(queryRunner, 'runs', 'active_attempt', 'text');
    await addColumn(queryRunner, 'runs', 'owner_instance', 'text');
    await addColumn(queryRunner, 'step_stats', 'attempt_id', 'text');
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_step_stats_attempt_id" ON "step_stats" ("attempt_id") WHERE "attempt_id" IS NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_step_stats_attempt_id"`);
    await queryRunner.query(`ALTER TABLE "step_stats" DROP COLUMN "attempt_id"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "owner_instance"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "active_attempt"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "revision"`);
  }
}
