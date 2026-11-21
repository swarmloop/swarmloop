import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The login of the person behind a command, null for the server's own. A database that `synchronize` built already has the column. */
export class CommandActor1796800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const present = (await queryRunner.query(`PRAGMA table_info("commands")`)) as { name: string }[];
    if (!present.some((existing) => existing.name === 'actor')) {
      await queryRunner.query(`ALTER TABLE "commands" ADD COLUMN "actor" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "commands" DROP COLUMN "actor"`);
  }
}
