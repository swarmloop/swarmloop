import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS = `"id", "run_id", "type", "payload", "idempotency_key", "expected_revision", "actor", "state", "result", "created_at", "updated_at"`;

/**
 * A command may have no run: `run_id` is nullable and `scope` names what a command of no run is for. SQLite cannot
 * loosen a column, so the table is rebuilt. A database that `synchronize` built already has the column and is left alone.
 */
export class CommandsWithoutRun1797800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("commands")`)) as { name: string }[];
    if (columns.some((existing) => existing.name === 'scope')) return;
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_commands_run_idempotency"`);
    await queryRunner.query(
      `CREATE TABLE "commands_next" ("id" varchar PRIMARY KEY NOT NULL, "run_id" integer, "type" varchar NOT NULL, "payload" text NOT NULL, "idempotency_key" text, "expected_revision" integer, "actor" text, "state" varchar NOT NULL, "result" text, "created_at" varchar NOT NULL, "updated_at" varchar NOT NULL, "scope" text)`,
    );
    await queryRunner.query(`INSERT INTO "commands_next" (${COLUMNS}) SELECT ${COLUMNS} FROM "commands"`);
    await queryRunner.query(`DROP TABLE "commands"`);
    await queryRunner.query(`ALTER TABLE "commands_next" RENAME TO "commands"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_commands_run_idempotency" ON "commands" ("run_id", "idempotency_key")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_commands_scope_idempotency" ON "commands" ("scope", "idempotency_key")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("commands")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'scope')) return;
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_commands_scope_idempotency"`);
    await queryRunner.query(`DELETE FROM "commands" WHERE "run_id" IS NULL`);
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "scope"`);
  }
}
