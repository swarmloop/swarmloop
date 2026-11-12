import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Personal settings per login, the agents a run started with, and who made a host app. A `synchronize`-built database has them already. */
export class UserSettings1795400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "user_settings" ("login" varchar NOT NULL, "key" varchar NOT NULL, "value" text NOT NULL, PRIMARY KEY ("login", "key"))`,
    );
    await this.addColumn(queryRunner, 'runs', 'agents', 'text');
    await this.addColumn(queryRunner, 'host_apps', 'made_by', 'text');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "host_apps" DROP COLUMN "made_by"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "agents"`);
    await queryRunner.query(`DROP TABLE "user_settings"`);
  }

  private async addColumn(queryRunner: QueryRunner, table: string, column: string, type: string): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === column)) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
    }
  }
}
