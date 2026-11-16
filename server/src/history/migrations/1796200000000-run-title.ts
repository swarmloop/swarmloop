import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A short title for each run, written by research. A database that `synchronize` built already has the column. */
export class RunTitle1796200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'title')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "title" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (columns.some((existing) => existing.name === 'title')) {
      await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "title"`);
    }
  }
}
