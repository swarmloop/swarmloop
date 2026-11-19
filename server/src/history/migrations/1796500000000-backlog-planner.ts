import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The conversation with a backlog's planner and its turns are stored; an index finds the events of a turn. */
export class BacklogPlanner1796500000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backlog_messages" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "backlog_id" integer NOT NULL, "message_key" text NOT NULL, "author" text NOT NULL, "kind" text NOT NULL DEFAULT ('message'), "text" text NOT NULL, "proposes" integer, "turn" text, "created_at" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_backlog_messages_backlog_key" ON "backlog_messages" ("backlog_id", "message_key")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backlog_turns" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "backlog_id" integer NOT NULL, "turn_key" text NOT NULL, "status" text NOT NULL, "reason" text NOT NULL DEFAULT (''), "next_try_at" text, "created_at" text NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_backlog_turns_turn_key" ON "backlog_turns" ("turn_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_backlog_events_backlog_turn" ON "backlog_events" ("backlog_id", "turn")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_backlog_events_backlog_turn"`);
    await queryRunner.query(`DROP INDEX "IDX_backlog_turns_turn_key"`);
    await queryRunner.query(`DROP TABLE "backlog_turns"`);
    await queryRunner.query(`DROP INDEX "IDX_backlog_messages_backlog_key"`);
    await queryRunner.query(`DROP TABLE "backlog_messages"`);
  }
}
