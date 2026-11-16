import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Backlogs with their milestones, requirements, tasks, decisions and events. Nothing that exists is changed. */
export class Backlogs1796200000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backlogs" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "name" text NOT NULL, "owner" text NOT NULL, "repositories" text NOT NULL, "merge_mode" text NOT NULL, "paused" boolean NOT NULL DEFAULT (0), "created_at" text NOT NULL)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_backlogs_name" ON "backlogs" ("name")`);
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backlog_milestones" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "backlog_id" integer NOT NULL, "number" integer NOT NULL, "title" text NOT NULL, "goal" text NOT NULL, "status" text NOT NULL, "created_at" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_backlog_milestones_backlog_number" ON "backlog_milestones" ("backlog_id", "number")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backlog_requirements" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "milestone_id" integer NOT NULL, "ref" text NOT NULL, "text" text NOT NULL, "status" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_backlog_requirements_milestone_ref" ON "backlog_requirements" ("milestone_id", "ref")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backlog_tasks" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "backlog_id" integer NOT NULL, "milestone_id" integer, "slug" text NOT NULL, "title" text NOT NULL, "description" text NOT NULL, "repositories" text NOT NULL, "covers" text NOT NULL, "depends" text NOT NULL, "files" text NOT NULL, "proof" text NOT NULL, "manual" boolean NOT NULL DEFAULT (0), "fixes_main" text, "status" text NOT NULL, "run_key" text, "merged" text NOT NULL, "made_by" text NOT NULL, "position" integer NOT NULL, "created_at" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_backlog_tasks_backlog_slug" ON "backlog_tasks" ("backlog_id", "slug")`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_backlog_tasks_run_key" ON "backlog_tasks" ("run_key")`);
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backlog_decisions" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "backlog_id" integer NOT NULL, "text" text NOT NULL, "who" text NOT NULL, "created_at" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backlog_events" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "backlog_id" integer NOT NULL, "event_key" text NOT NULL, "kind" text NOT NULL, "facts" text NOT NULL, "turn" text, "created_at" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_backlog_events_backlog_key" ON "backlog_events" ("backlog_id", "event_key")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_backlog_events_backlog_key"`);
    await queryRunner.query(`DROP TABLE "backlog_events"`);
    await queryRunner.query(`DROP TABLE "backlog_decisions"`);
    await queryRunner.query(`DROP INDEX "IDX_backlog_tasks_run_key"`);
    await queryRunner.query(`DROP INDEX "IDX_backlog_tasks_backlog_slug"`);
    await queryRunner.query(`DROP TABLE "backlog_tasks"`);
    await queryRunner.query(`DROP INDEX "IDX_backlog_requirements_milestone_ref"`);
    await queryRunner.query(`DROP TABLE "backlog_requirements"`);
    await queryRunner.query(`DROP INDEX "IDX_backlog_milestones_backlog_number"`);
    await queryRunner.query(`DROP TABLE "backlog_milestones"`);
    await queryRunner.query(`DROP INDEX "IDX_backlogs_name"`);
    await queryRunner.query(`DROP TABLE "backlogs"`);
  }
}
