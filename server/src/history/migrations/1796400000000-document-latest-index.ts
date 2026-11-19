import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The latest document of a kind per run is found on this index, without reading a body. */
export class DocumentLatestIndex1796400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_documents_run_kind_id" ON "documents" ("run_id", "kind", "id")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_documents_run_kind_id"`);
  }
}
