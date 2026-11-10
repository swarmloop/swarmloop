import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A run stores whether the planner may split it into subtasks. Old rows read as off. */
export class RunSplit1794700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'split')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "split" boolean NOT NULL DEFAULT (0)`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "split"`);
  }
}
