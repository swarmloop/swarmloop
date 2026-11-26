import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The photo of a person. A database that `synchronize` built already has the column. */
export class PersonAvatar1797500000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("people")`)) as { name: string }[];
    if (!columns.some((existing) => existing.name === 'avatar_url')) {
      await queryRunner.query(`ALTER TABLE "people" ADD COLUMN "avatar_url" text`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const columns = (await queryRunner.query(`PRAGMA table_info("people")`)) as { name: string }[];
    if (columns.some((existing) => existing.name === 'avatar_url')) {
      await queryRunner.query(`ALTER TABLE "people" DROP COLUMN "avatar_url"`);
    }
  }
}
