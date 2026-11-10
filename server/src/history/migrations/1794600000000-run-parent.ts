import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A subtask run points at its parent run and at its task id in the parent's `subtasks` document. */
export class RunParent1794600000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'parent_run_id')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "parent_run_id" integer`);
    }
    if (!columns.some((existing) => existing.name === 'task_id')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "task_id" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "task_id"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "parent_run_id"`);
  }
}
