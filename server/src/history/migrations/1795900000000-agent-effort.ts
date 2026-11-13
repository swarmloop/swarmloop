import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS: { table: string; column: string }[] = [
  { table: 'runs', column: 'epic_at' },
  { table: 'step_stats', column: 'effort' },
  { table: 'step_stats', column: 'effort_note' },
];

/** The effort a visit ran with, and when a run's plan became a split. A database that `synchronize` built already has the columns. */
export class AgentEffort1795900000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, column } of COLUMNS) {
      const columns = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as { name: string }[];
      if (!columns.some((existing) => existing.name === column)) {
        await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" text`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const { table, column } of COLUMNS) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    }
  }
}
