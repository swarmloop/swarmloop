import type { MigrationInterface, QueryRunner } from 'typeorm';

const ADDED_COLUMNS = [
  { name: 'note', definition: `text NOT NULL DEFAULT ('')` },
  { name: 'run_now', definition: 'boolean NOT NULL DEFAULT (0)' },
];

/** What the scheduler says about a task, and whether the owner asked to run it now. A column that exists is left as it is. */
export class BacklogTaskNote1796300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("backlog_tasks")`)) as { name: string }[];
    for (const column of ADDED_COLUMNS) {
      if (!columns.some((existing) => existing.name === column.name)) {
        await queryRunner.query(`ALTER TABLE "backlog_tasks" ADD COLUMN "${column.name}" ${column.definition}`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of ADDED_COLUMNS) {
      await queryRunner.query(`ALTER TABLE "backlog_tasks" DROP COLUMN "${column.name}"`);
    }
  }
}
