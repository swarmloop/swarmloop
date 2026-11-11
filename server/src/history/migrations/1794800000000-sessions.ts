import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Login sessions, and who started a run. A database that `synchronize` built has both. */
export class Sessions1794800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "sessions" ("id" text PRIMARY KEY NOT NULL, "user" text NOT NULL, "provider" text NOT NULL, "expires_at" text NOT NULL)`,
    );
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'started_by')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "started_by" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "started_by"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
  }
}
