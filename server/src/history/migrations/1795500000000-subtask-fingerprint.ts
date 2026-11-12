import type { MigrationInterface, QueryRunner } from 'typeorm';

/** What the last pass of a split parent saw of its subtasks (`runs.subtask_fingerprint`). A database that `synchronize` built already has the column. */
export class SubtaskFingerprint1795500000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (!columns.some((column) => column.name === 'subtask_fingerprint')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "subtask_fingerprint" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "subtask_fingerprint"`);
  }
}
