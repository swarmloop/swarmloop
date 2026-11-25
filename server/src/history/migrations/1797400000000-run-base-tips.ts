import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The base tip each repository of a run stands on. A database that `synchronize` built already has the column. */
export class RunBaseTips1797400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'base_tips')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "base_tips" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (columns.some((existing) => existing.name === 'base_tips')) {
      await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "base_tips"`);
    }
  }
}
