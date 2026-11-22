import type { MigrationInterface, QueryRunner } from 'typeorm';

/** How each agent visit was started is stored. A database that `synchronize` built has the table. */
export class VisitStarts1797000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "visit_starts" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "run_id" integer NOT NULL, "step" text NOT NULL, "attempt_id" text NOT NULL, "started_by" text NOT NULL, "level" integer, "input_digest" text, "start_reason" text, "rerun_unfinished" integer NOT NULL DEFAULT (0), "created_at" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_visit_starts_attempt_id" ON "visit_starts" ("attempt_id")`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_visit_starts_run_id" ON "visit_starts" ("run_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_visit_starts_run_id"`);
    await queryRunner.query(`DROP INDEX "IDX_visit_starts_attempt_id"`);
    await queryRunner.query(`DROP TABLE "visit_starts"`);
  }
}
