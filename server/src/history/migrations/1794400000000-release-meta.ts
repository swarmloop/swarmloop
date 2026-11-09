import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The release version that last migrated the database, one row. A database that `synchronize` built already has it. */
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
