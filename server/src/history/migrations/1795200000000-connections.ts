import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The stored GitHub App or GitLab application of each host, and the tokens of each connected person. Secrets are ciphertext. */
export class Connections1795200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "host_apps" ("id" text PRIMARY KEY NOT NULL, "app_id" text NOT NULL, "slug" text NOT NULL, "client_id" text NOT NULL, "client_secret" text NOT NULL, "private_key" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "connections" ("id" text PRIMARY KEY NOT NULL, "host" text NOT NULL, "login" text NOT NULL, "access_token" text NOT NULL, "refresh_token" text NOT NULL, "expires_at" text, "refreshed_at" text, "status" text NOT NULL, "installation_id" text, "selection" text)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "connections"`);
    await queryRunner.query(`DROP TABLE "host_apps"`);
  }
}
