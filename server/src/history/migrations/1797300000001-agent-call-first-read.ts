import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A row of the log keeps what its first model request read from the cache, which the keep-warm saving prices. A database that `synchronize` built has the column. */
export class AgentCallFirstRead1797300000001 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("agent_exchanges")`)) as { name: string }[];
    if (!columns.some((column) => column.name === 'first_cache_read_tokens')) {
      await queryRunner.query(`ALTER TABLE "agent_exchanges" ADD COLUMN "first_cache_read_tokens" integer`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_exchanges" DROP COLUMN "first_cache_read_tokens"`);
  }
}
