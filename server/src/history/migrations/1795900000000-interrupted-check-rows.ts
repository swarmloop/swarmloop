import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A check row of a cut attempt that never got an end is closed as interrupted. Its end is the end of the attempt's
 * visit, else its own start, never the time of this migration. A run's active attempt is left to the settler.
 */
export class InterruptedCheckRows1795900000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE check_commands
       SET status = 'interrupted',
           exit_code = NULL,
           ended_at = COALESCE((SELECT finished_at FROM step_stats WHERE step_stats.attempt_id = check_commands.attempt_id), started_at)
       WHERE ended_at IS NULL AND status IN ('waiting', 'running')
         AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.active_attempt = check_commands.attempt_id)`,
    );
  }

  async down(): Promise<void> {
    // The rows were left open by a process that died; what state each had cannot be known, so nothing is restored.
  }
}
