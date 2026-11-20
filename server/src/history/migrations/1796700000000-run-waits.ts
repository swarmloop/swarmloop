import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The stretches in which a run waited for a person or a next try are stored. A database that `synchronize` built has the table. */
export class RunWaits1796700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "run_waits" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "run_id" integer NOT NULL, "kind" text NOT NULL, "code" text, "started_at" text NOT NULL, "ended_at" text)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_run_waits_run_id" ON "run_waits" ("run_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_run_waits_run_id"`);
    await queryRunner.query(`DROP TABLE "run_waits"`);
  }
}
