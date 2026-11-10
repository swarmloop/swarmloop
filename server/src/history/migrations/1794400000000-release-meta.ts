import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Kept in the list because databases already ran it; DropReleaseMeta1794500000000 removes the table again. */
export class ReleaseMeta1794400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "release_meta" ("id" integer PRIMARY KEY NOT NULL, "version" varchar NOT NULL)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "release_meta"`);
  }
}
