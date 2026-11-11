import type { MigrationInterface, QueryRunner } from 'typeorm';

/** How a done run's merge requests ended, and when the merge watch first saw it done. A database that `synchronize` built already has the columns. */
export class MergeOutcome1795200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    for (const name of ['merge_outcome', 'done_at']) {
      if (!columns.some((column) => column.name === name)) {
        await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "${name}" text`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "merge_outcome"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "done_at"`);
  }
}
