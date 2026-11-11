import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The gap before a visit's first event, stored with the visit. A database that `synchronize` built already has the column. */
export class PreparedMs1795100000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("step_stats")`)) as { name: string }[];
    if (!columns.some((column) => column.name === 'prepared_ms')) {
      await queryRunner.query(`ALTER TABLE "step_stats" ADD COLUMN "prepared_ms" integer`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_stats" DROP COLUMN "prepared_ms"`);
  }
}
