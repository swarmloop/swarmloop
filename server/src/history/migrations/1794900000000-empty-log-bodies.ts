import { existsSync } from 'fs';
import { dirname } from 'path';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { attemptOutputPath } from '../../core/attempt-output';

const BATCH = 200;

interface StoredLog {
  id: number;
  key: string;
  step: string;
  attemptId: string | null;
}

/**
 * An agent log lives in its attempt file. The stored copy of a log whose file exists is emptied. A log with no
 * attempt id or no file stays: no other file may stand in for it.
 */
export class EmptyLogBodies1794900000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const database = queryRunner.connection.options.database;
    if (typeof database !== 'string' || database === ':memory:') {
      return;
    }
    const root = dirname(dirname(database));
    let after = 0;
    for (;;) {
      const rows = (await queryRunner.query(
        `SELECT d.id AS id, r.key AS key, s.step AS step, s.attempt_id AS attemptId
         FROM documents d
         JOIN step_stats s ON s.id = d.step_stat_id
         JOIN runs r ON r.id = d.run_id
         WHERE d.kind = 'log' AND d.body <> '' AND d.id > ?
         ORDER BY d.id LIMIT ${BATCH}`,
        [after],
      )) as StoredLog[];
      for (const row of rows) {
        if (row.attemptId && existsSync(attemptOutputPath(root, row.key, row.step, row.attemptId))) {
          await queryRunner.query(`UPDATE documents SET body = '' WHERE id = ?`, [row.id]);
        }
      }
      if (rows.length < BATCH) {
        return;
      }
      after = rows[rows.length - 1].id;
    }
  }

  async down(): Promise<void> {
    // The emptied bodies are in the attempt files; nothing to restore.
  }
}
