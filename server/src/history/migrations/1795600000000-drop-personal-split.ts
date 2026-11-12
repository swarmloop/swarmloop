import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Splitting is a server setting only: a personal `split` row of `user_settings` is no longer read. */
export class DropPersonalSplit1795600000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "user_settings" WHERE "key" = 'split'`);
  }

  async down(): Promise<void> {
    // Deleted rows are not restored.
  }
}
