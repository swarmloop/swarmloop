import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The secrets a person stored for an integration, encrypted. A `synchronize`-built database has the table already. */
export class IntegrationSecrets1796000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "integration_secrets" ("id" text PRIMARY KEY NOT NULL, "connection" text NOT NULL, "login" text NOT NULL, "secret" text NOT NULL, "last4" text NOT NULL, "account" text, "status" text NOT NULL, "reason" text, "saved_at" text NOT NULL)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "integration_secrets"`);
  }
}
