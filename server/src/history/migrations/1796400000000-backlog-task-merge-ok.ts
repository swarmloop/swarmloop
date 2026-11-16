import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Whether the owner said a task may merge. A column that exists is left as it is. */
export class BacklogTaskMergeOk1796400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("backlog_tasks")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'merge_ok')) {
      await queryRunner.query(`ALTER TABLE "backlog_tasks" ADD COLUMN "merge_ok" boolean NOT NULL DEFAULT (0)`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "backlog_tasks" DROP COLUMN "merge_ok"`);
  }
}
