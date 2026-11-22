import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The cost of a resumed launch reads the visits of one chat; the index keeps that from scanning every exchange. */
export class AgentExchangeChatIndex1797000000002 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_agent_exchanges_chat_id" ON "agent_exchanges" ("chat_id")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_agent_exchanges_chat_id"');
  }
}
