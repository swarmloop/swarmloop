import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The files a person sent with a backlog message, as a JSON list. A database that `synchronize` built already has the column. */
export class BacklogMessageAttachments1796700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const present = (await queryRunner.query(`PRAGMA table_info("backlog_messages")`)) as { name: string }[];
    if (!present.some((existing) => existing.name === 'attachments')) {
      await queryRunner.query(`ALTER TABLE "backlog_messages" ADD COLUMN "attachments" text NOT NULL DEFAULT ('[]')`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "backlog_messages" DROP COLUMN "attachments"`);
  }
}
