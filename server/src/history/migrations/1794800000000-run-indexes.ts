import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Every column a run page filters on. A database that `synchronize` built has them. */
const INDEXES: [name: string, table: string, column: string][] = [
  ['IDX_documents_run_id', 'documents', 'run_id'],
  ['IDX_documents_step_stat_id', 'documents', 'step_stat_id'],
  ['IDX_step_stats_run_id', 'step_stats', 'run_id'],
  ['IDX_agent_exchanges_step_stat_id', 'agent_exchanges', 'step_stat_id'],
  ['IDX_resource_samples_step_stat_id', 'resource_samples', 'step_stat_id'],
  ['IDX_http_calls_run_id', 'http_calls', 'run_id'],
  ['IDX_loop_events_run_id', 'loop_events', 'run_id'],
  ['IDX_flows_run_id', 'flows', 'run_id'],
  ['IDX_runs_parent_run_id', 'runs', 'parent_run_id'],
  ['IDX_pastes_run_key', 'pastes', 'run_key'],
];

export class RunIndexes1794800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, table, column] of INDEXES) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" ("${column}")`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of INDEXES) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    }
  }
}
