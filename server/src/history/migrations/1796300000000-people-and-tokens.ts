import type { MigrationInterface, QueryRunner } from 'typeorm';

/** People with a role, their personal API tokens, and the person a run belongs to since a takeover. Each app maker becomes an admin. */
export class PeopleAndTokens1796300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "people" ("login" text PRIMARY KEY NOT NULL, "role" text NOT NULL, "created_at" text NOT NULL, "env_token_imported_at" text)`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "personal_tokens" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "login" text NOT NULL, "name" text NOT NULL, "token_hash" text NOT NULL, "created_at" text NOT NULL, "last_used_at" text, "expires_at" text)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_personal_tokens_token_hash" ON "personal_tokens" ("token_hash")`,
    );
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'owner_since')) {
      await queryRunner.query(`ALTER TABLE "runs" ADD COLUMN "owner_since" text`);
    }
    await queryRunner.query(
      `INSERT OR IGNORE INTO "people" ("login", "role", "created_at") SELECT DISTINCT "made_by", 'admin', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "host_apps" WHERE "made_by" IS NOT NULL AND "made_by" <> '' AND "made_by" <> 'machine'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "personal_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "people"`);
    const columns = (await queryRunner.query(`PRAGMA table_info("runs")`)) as { name: string }[];
    if (columns.some((existing) => existing.name === 'owner_since')) {
      await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "owner_since"`);
    }
  }
}
