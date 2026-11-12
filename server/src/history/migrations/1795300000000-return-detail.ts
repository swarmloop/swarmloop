import type { MigrationInterface, QueryRunner } from 'typeorm';

/** What a return was about (`loop_events.detail`) and the content each project was checked at (`step_stats.checked_commits`). A database that `synchronize` built already has the columns. */
export class ReturnDetail1795300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, name] of [
      ['loop_events', 'detail'],
      ['step_stats', 'checked_commits'],
    ]) {
      const columns = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as { name: string }[];
      if (!columns.some((column) => column.name === name)) {
        await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${name}" text`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "loop_events" DROP COLUMN "detail"`);
    await queryRunner.query(`ALTER TABLE "step_stats" DROP COLUMN "checked_commits"`);
  }
}
