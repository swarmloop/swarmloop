import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline of the history schema. Every statement is idempotent, so a database that `synchronize` built is left as it is.
 */
export class InitialSchema1793664000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS "runs" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "key" varchar NOT NULL,
        "status" varchar NOT NULL,
        "current_step" varchar NOT NULL,
        "runtime" varchar NOT NULL,
        "requirements_via" varchar NOT NULL,
        "issue_tracker" varchar NOT NULL,
        "code_host" varchar NOT NULL,
        "attempts_review" integer NOT NULL DEFAULT (0),
        "attempts_qa" integer NOT NULL DEFAULT (0),
        "attempts_pipeline" integer NOT NULL DEFAULT (0),
        "agent_calls" integer NOT NULL DEFAULT (0),
        "spent_usd" float NOT NULL DEFAULT (0),
        "target_path" text,
        "projects" text,
        "owner_pid" integer,
        "prompt" text,
        "created_at" varchar NOT NULL,
        "updated_at" varchar NOT NULL,
        "step_started_at" text,
        CONSTRAINT "UQ_5ea9cda5f88a328ec492cbbe82d" UNIQUE ("key")
      )`,
      `CREATE TABLE IF NOT EXISTS "documents" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "run_id" integer NOT NULL,
        "step_stat_id" integer NOT NULL,
        "kind" varchar NOT NULL,
        "attempt" integer NOT NULL,
        "body" text NOT NULL,
        "path" varchar NOT NULL,
        "created_at" varchar NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "step_stats" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "run_id" integer NOT NULL,
        "step" varchar NOT NULL,
        "attempt" integer NOT NULL,
        "model" text,
        "mode" text,
        "started_at" varchar NOT NULL,
        "step_started_at" text,
        "finished_at" varchar NOT NULL,
        "duration_ms" integer NOT NULL,
        "status" varchar NOT NULL,
        "exit_code" integer,
        "kill_reason" text,
        "tokens_in" integer NOT NULL DEFAULT (0),
        "tokens_out" integer NOT NULL DEFAULT (0),
        "usd" float NOT NULL DEFAULT (0),
        "cpu_avg" float NOT NULL DEFAULT (0),
        "cpu_peak" float NOT NULL DEFAULT (0),
        "mem_avg" integer NOT NULL DEFAULT (0),
        "mem_peak" integer NOT NULL DEFAULT (0),
        "resumed" integer NOT NULL DEFAULT (0)
      )`,
      `CREATE TABLE IF NOT EXISTS "resource_samples" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "step_stat_id" integer NOT NULL,
        "sampled_at" varchar NOT NULL,
        "cpu_percent" float NOT NULL,
        "rss_bytes" integer NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "agent_exchanges" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "step_stat_id" integer NOT NULL,
        "model" varchar NOT NULL,
        "started_at" varchar NOT NULL,
        "finished_at" varchar NOT NULL,
        "duration_ms" integer NOT NULL,
        "request_text" text NOT NULL,
        "response_text" text NOT NULL,
        "chat_id" text,
        "resumed" integer NOT NULL DEFAULT (0),
        "kill_reason" text
      )`,
      `CREATE TABLE IF NOT EXISTS "loop_events" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "run_id" integer NOT NULL,
        "counter" varchar NOT NULL,
        "attempt" integer NOT NULL,
        "reason" text NOT NULL,
        "created_at" varchar NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "http_calls" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "run_id" integer NOT NULL,
        "step_stat_id" integer NOT NULL,
        "provider" varchar NOT NULL,
        "method" varchar NOT NULL,
        "url" varchar NOT NULL,
        "status_code" integer,
        "duration_ms" integer NOT NULL,
        "error" text,
        "created_at" varchar NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "pastes" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "run_key" varchar NOT NULL,
        "url" varchar NOT NULL,
        "body" text NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS "checkouts" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "name" varchar NOT NULL,
        "path" text NOT NULL,
        CONSTRAINT "UQ_0f53a2ff605cb2eca8f942a2431" UNIQUE ("name")
      )`,
      `CREATE TABLE IF NOT EXISTS "deny_paths" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "pattern" varchar NOT NULL,
        CONSTRAINT "UQ_65c324885ef695ee66d0cb910e8" UNIQUE ("pattern")
      )`,
      `CREATE TABLE IF NOT EXISTS "flows" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "run_id" integer NOT NULL,
        "phases" text NOT NULL,
        "from_step" text,
        "created_at" varchar NOT NULL
      )`,
    ];
    for (const statement of statements) {
      await queryRunner.query(statement);
    }
  }

  async down(): Promise<void> {
    // The baseline is not reversed: dropping it would destroy the history.
  }
}
