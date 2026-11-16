import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The milestone a queued milestone waits for. A column that exists is left as it is. */
export class BacklogMilestoneQueue1796500000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("backlog_milestones")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'queued_after_id')) {
      await queryRunner.query(`ALTER TABLE "backlog_milestones" ADD COLUMN "queued_after_id" integer`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "backlog_milestones" DROP COLUMN "queued_after_id"`);
  }
}
