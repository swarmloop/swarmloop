import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS = [
  { name: 'reported_usd', type: 'float' },
  { name: 'reported_tokens_in', type: 'integer' },
  { name: 'reported_tokens_out', type: 'integer' },
];

/** An exchange keeps the session totals its last result line reported, so the next launch of the chat is taken against them. A database that `synchronize` built has them. */
export class ExchangeReportedTotals1797200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("agent_exchanges")`)) as { name: string }[];
    for (const column of COLUMNS) {
      if (!columns.some((existing) => existing.name === column.name)) {
        await queryRunner.query(`ALTER TABLE "agent_exchanges" ADD COLUMN "${column.name}" ${column.type}`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of COLUMNS) {
      await queryRunner.query(`ALTER TABLE "agent_exchanges" DROP COLUMN "${column.name}"`);
    }
  }
}
