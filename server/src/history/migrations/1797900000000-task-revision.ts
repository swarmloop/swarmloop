import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The revision of a task: how many changes it has had, for a change to name what it read. */
export class TaskRevision1797900000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("backlog_tasks")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'revision')) {
      await queryRunner.query(`ALTER TABLE "backlog_tasks" ADD COLUMN "revision" integer NOT NULL DEFAULT (0)`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("backlog_tasks")`)) as { name: string }[];
    if (columns.some((existing) => existing.name === 'revision')) {
      await queryRunner.query(`ALTER TABLE "backlog_tasks" DROP COLUMN "revision"`);
    }
  }
}
