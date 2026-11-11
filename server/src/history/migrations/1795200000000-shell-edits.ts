import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The files a visit changed through the shell, stored with the visit. A database that `synchronize` built already has the column. */
export class ShellEdits1795200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("step_stats")`)) as { name: string }[];
    if (!columns.some((column) => column.name === 'shell_edits')) {
      await queryRunner.query(`ALTER TABLE "step_stats" ADD COLUMN "shell_edits" integer NOT NULL DEFAULT 0`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_stats" DROP COLUMN "shell_edits"`);
  }
}
