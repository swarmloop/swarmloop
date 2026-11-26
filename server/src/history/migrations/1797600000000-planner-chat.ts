import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The call log keeps the prompt size of a row's last request, and a backlog turn keeps the state the planner chat has seen. A database that `synchronize` built has both columns. */
export class PlannerChat1797600000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await this.addColumn(queryRunner, 'agent_exchanges', 'last_prompt_tokens', 'integer');
    await this.addColumn(queryRunner, 'backlog_turns', 'seen_state', 'text');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agent_exchanges" DROP COLUMN "last_prompt_tokens"`);
    await queryRunner.query(`ALTER TABLE "backlog_turns" DROP COLUMN "seen_state"`);
  }

  private async addColumn(queryRunner: QueryRunner, table: string, column: string, type: string): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === column)) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
    }
  }
}
