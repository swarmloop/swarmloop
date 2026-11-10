import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A visit records the runtime of its agent next to the model, so spend and statistics by agent are per step. A database that `synchronize` built has it. */
export class StepRuntime1794600000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("step_stats")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'runtime')) {
      await queryRunner.query(`ALTER TABLE "step_stats" ADD COLUMN "runtime" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_stats" DROP COLUMN "runtime"`);
  }
}
