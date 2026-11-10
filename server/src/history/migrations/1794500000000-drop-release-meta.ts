import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The database no longer records a release version: a server refuses a database by its unknown migrations alone. */
export class DropReleaseMeta1794500000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "release_meta"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "release_meta" ("id" integer PRIMARY KEY NOT NULL, "version" varchar NOT NULL)`,
    );
  }
}
