import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The verify step is gone: a run that stood on it goes on with code review, the step that followed it. */
export class RetireVerifyStep1793800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "runs" SET "current_step" = 'code-review' WHERE "current_step" = 'verify'`);
  }

  async down(): Promise<void> {
    return Promise.resolve();
  }
}
