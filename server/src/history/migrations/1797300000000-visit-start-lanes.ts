import type { MigrationInterface, QueryRunner } from 'typeorm';

const COLUMNS = [
  { name: 'outside', definition: 'integer NOT NULL DEFAULT (0)' },
  { name: 'stat_id', definition: 'integer' },
];

/** A start row says whether its agent start was a step's visit or outside one, and which stored visit it links. A database that `synchronize` built has the columns. */
export class VisitStartLanes1797300000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("visit_starts")`)) as { name: string }[];
    for (const column of COLUMNS) {
      if (!columns.some((existing) => existing.name === column.name)) {
        await queryRunner.query(`ALTER TABLE "visit_starts" ADD COLUMN "${column.name}" ${column.definition}`);
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of COLUMNS) {
      await queryRunner.query(`ALTER TABLE "visit_starts" DROP COLUMN "${column.name}"`);
    }
  }
}
