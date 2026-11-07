import type { MigrationInterface, QueryRunner } from 'typeorm';

async function addColumn(queryRunner: QueryRunner, table: string, column: string, definition: string): Promise<void> {
  const columns = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as { name: string }[];
  if (!columns.some((existing) => existing.name === column)) {
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

/** The durable commands of a run and the honest state columns. A database that `synchronize` built already has them. */
export class Commands1794100000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await addColumn(queryRunner, 'runs', 'state', 'text');
    await addColumn(queryRunner, 'runs', 'state_reason', 'text');
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "commands" ("id" varchar PRIMARY KEY NOT NULL, "run_id" integer NOT NULL, "type" varchar NOT NULL, "payload" text NOT NULL, "idempotency_key" text, "expected_revision" integer, "state" varchar NOT NULL, "result" text, "created_at" varchar NOT NULL, "updated_at" varchar NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_commands_run_idempotency" ON "commands" ("run_id", "idempotency_key")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_commands_run_idempotency"`);
    await queryRunner.query(`DROP TABLE "commands"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "state_reason"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "state"`);
  }
}
