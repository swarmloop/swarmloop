import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Why a flow was made; `rebase` marks a relaunch after a rebase. A database that `synchronize` built already has the column. */
export class FlowCause1797500000001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("flows")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'cause')) {
      await queryRunner.query(`ALTER TABLE "flows" ADD COLUMN "cause" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("flows")`)) as { name: string }[];
    if (columns.some((existing) => existing.name === 'cause')) {
      await queryRunner.query(`ALTER TABLE "flows" DROP COLUMN "cause"`);
    }
  }
}
