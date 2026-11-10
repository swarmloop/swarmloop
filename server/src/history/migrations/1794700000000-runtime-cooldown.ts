import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A runtime whose provider limit has not ended is stored, so a restart keeps it. A database that `synchronize` built has it. */
export class RuntimeCooldown1794700000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "runtime_cooldowns" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "runtime" text NOT NULL, "until" text NOT NULL, "reset_known" integer NOT NULL, CONSTRAINT "UQ_runtime_cooldowns_runtime" UNIQUE ("runtime"))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "runtime_cooldowns"`);
  }
}
