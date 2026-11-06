import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The durable events of a step. A database that `synchronize` built already has the table. */
export class StepEvents1794000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "step_events" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "run_id" integer NOT NULL, "attempt_id" varchar NOT NULL, "step" varchar NOT NULL, "seq" integer NOT NULL, "kind" varchar NOT NULL, "payload" text NOT NULL, "occurred_at" varchar NOT NULL, "recorded_at" varchar NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_step_events_run_seq" ON "step_events" ("run_id", "seq")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_step_events_run_seq"`);
    await queryRunner.query(`DROP TABLE "step_events"`);
  }
}
