import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The starts the planner offers with a backlog message, as a JSON list. A database that `synchronize` built already has the column. */
export class BacklogMessageOffers1798000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const present = (await queryRunner.query(`PRAGMA table_info("backlog_messages")`)) as { name: string }[];
    if (!present.some((existing) => existing.name === 'offers')) {
      await queryRunner.query(`ALTER TABLE "backlog_messages" ADD COLUMN "offers" text NOT NULL DEFAULT ('[]')`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "backlog_messages" DROP COLUMN "offers"`);
  }
}
