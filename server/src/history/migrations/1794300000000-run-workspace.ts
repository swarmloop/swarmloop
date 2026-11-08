import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Set to `removed` when retention took the worktrees of a done run. A database that `synchronize` built has it. */
export class RunWorkspace1794300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'workspace')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "workspace" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "workspace"`);
  }
}
