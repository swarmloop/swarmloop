import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Footprints join a visit's samples to its check commands by attempt. A database that `synchronize` built has it. */
export class CheckCommandsAttemptIndex1795800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_check_commands_attempt_id" ON "check_commands" ("attempt_id")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_check_commands_attempt_id"`);
  }
}
