import type { MigrationInterface, QueryRunner } from 'typeorm';

const DROPPED_COLUMNS = [
  { name: 'attempts_qa', definition: 'integer NOT NULL DEFAULT 0' },
  { name: 'requirements_via', definition: `varchar NOT NULL DEFAULT ''` },
  { name: 'issue_tracker', definition: `varchar NOT NULL DEFAULT ''` },
];

/**
 * Drops the tables and columns that nothing reads or writes any more. This migration deletes data: the stored `log`
 * documents of merged and closed runs, so the server compacts the database once after it.
 */
export class DropUnusedData1796100000000 implements MigrationInterface {
  readonly deletesData = true;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "documents" WHERE "kind" = 'log' AND "run_id" IN (SELECT "id" FROM "runs" WHERE "merge_outcome" IS NOT NULL)`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "runtime_cooldowns"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "deny_paths"`);
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    for (const column of DROPPED_COLUMNS) {
      if (columns.some((existing) => existing.name === column.name)) {
        await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "${column.name}"`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "runtime_cooldowns" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "runtime" text NOT NULL, "until" text NOT NULL, "reset_known" integer NOT NULL, CONSTRAINT "UQ_runtime_cooldowns_runtime" UNIQUE ("runtime"))`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "deny_paths" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "pattern" varchar NOT NULL, CONSTRAINT "UQ_65c324885ef695ee66d0cb910e8" UNIQUE ("pattern"))`,
    );
    for (const column of DROPPED_COLUMNS) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "${column.name}" ${column.definition}`);
    }
  }
}
