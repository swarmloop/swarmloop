import type { MigrationInterface, QueryRunner } from 'typeorm';

async function addColumn(queryRunner: QueryRunner, table: string, column: string, definition: string): Promise<void> {
  const columns = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as { name: string }[];
  if (!columns.some((existing) => existing.name === column)) {
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

/**
 * The generation of a run, which grows when a Replay or a Rebase is accepted, and the stamp a gate document carries.
 * A database that `synchronize` built already has them.
 */
export class RunGeneration1794200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await addColumn(queryRunner, 'runs', 'generation', 'integer NOT NULL DEFAULT (0)');
    await addColumn(queryRunner, 'documents', 'stamp', 'text');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "documents" DROP COLUMN "stamp"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "generation"`);
  }
}
