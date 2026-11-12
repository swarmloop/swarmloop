import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The short name of a check command. A database that `synchronize` built already has the column. */
export class CheckCommandName1795300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("check_commands")`)) as { name: string }[];
    if (!columns.some((column) => column.name === 'name')) {
      await queryRunner.query(`ALTER TABLE "check_commands" ADD COLUMN "name" varchar`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "check_commands" DROP COLUMN "name"`);
  }
}
