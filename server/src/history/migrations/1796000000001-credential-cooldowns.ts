import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Cooldowns per runtime and credential. A cooldown that still runs is kept as the server's own (`env`) credential. */
export class CredentialCooldowns1796000000001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "credential_cooldowns" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "runtime" text NOT NULL, "credential" text NOT NULL, "until" text NOT NULL, "reset_known" integer NOT NULL, CONSTRAINT "UQ_credential_cooldowns_runtime_credential" UNIQUE ("runtime", "credential"))`,
    );
    await queryRunner.query(
      `INSERT OR IGNORE INTO "credential_cooldowns" ("runtime", "credential", "until", "reset_known") SELECT "runtime", 'env', "until", "reset_known" FROM "runtime_cooldowns"`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "credential_cooldowns"`);
  }
}
