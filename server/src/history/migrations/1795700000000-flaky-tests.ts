import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Tests that failed and then passed on the same code are stored. A database that `synchronize` built has them. */
export class FlakyTests1795700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "flaky_tests" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "run_id" text NOT NULL, "project" text NOT NULL, "test" text NOT NULL, "ref" text NOT NULL, "seed" text, "failed_log" text NOT NULL, "passed_log" text NOT NULL, "created_at" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_flaky_tests_project_test" ON "flaky_tests" ("project", "test")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_flaky_tests_project_test"`);
    await queryRunner.query(`DROP TABLE "flaky_tests"`);
  }
}
