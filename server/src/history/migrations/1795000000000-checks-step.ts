import type { MigrationInterface, QueryRunner } from 'typeorm';

async function addColumn(queryRunner: QueryRunner, table: string, column: string, definition: string): Promise<void> {
  const columns = (await queryRunner.query(`PRAGMA table_info("${table}")`)) as { name: string }[];
  if (!columns.some((existing) => existing.name === column)) {
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

/** `requirements` and `brainstorm` are one phase, `planning`. A run that implemented also has the new `checks` phase. */
export function renamedPhases(phases: readonly unknown[]): unknown[] {
  const renamed = phases.map((name) => (name === 'requirements' || name === 'brainstorm' ? 'planning' : name));
  const unique = renamed.filter((name, index) => renamed.indexOf(name) === index);
  const at = unique.indexOf('implementation');
  if (at >= 0 && !unique.includes('checks')) {
    unique.splice(at + 1, 0, 'checks');
  }
  return unique;
}

/**
 * The checks step: its phase names in stored flows, its return counter, the rows of its commands, and the source of
 * a resource sample. A database that `synchronize` built already has the columns and the table.
 */
export class ChecksStep1795000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const flows = (await queryRunner.query(`SELECT id, phases FROM flows`)) as { id: number; phases: string }[];
    for (const flow of flows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(flow.phases);
      } catch {
        continue;
      }
      if (Array.isArray(parsed)) {
        await queryRunner.query(`UPDATE flows SET phases = ? WHERE id = ?`, [
          JSON.stringify(renamedPhases(parsed)),
          flow.id,
        ]);
      }
    }
    await addColumn(queryRunner, 'runs', 'attempts_checks', 'integer NOT NULL DEFAULT (0)');
    await addColumn(queryRunner, 'resource_samples', 'source', 'varchar');
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "check_commands" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "run_id" integer NOT NULL, "attempt_id" varchar NOT NULL, "repo" varchar NOT NULL, "command" text NOT NULL, "command_index" integer NOT NULL, "status" varchar NOT NULL, "skipped" integer NOT NULL DEFAULT (0), "started_at" varchar, "ended_at" varchar, "exit_code" integer)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_check_commands_run_id" ON "check_commands" ("run_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_check_commands_run_id"`);
    await queryRunner.query(`DROP TABLE "check_commands"`);
    await queryRunner.query(`ALTER TABLE "resource_samples" DROP COLUMN "source"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "attempts_checks"`);
  }
}
