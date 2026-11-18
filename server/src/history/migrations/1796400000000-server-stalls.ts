import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The server's stalls and its slow requests are stored. A database that `synchronize` built has them. */
export class ServerStalls1796400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "server_stalls" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "started_at" text NOT NULL, "duration_ms" integer NOT NULL, "kind" text NOT NULL, "running_agents" integer NOT NULL, "running_checks" integer NOT NULL, "running_setups" integer NOT NULL, "cpu_percent" real NOT NULL, "memory_bytes" integer NOT NULL, "vm_cpus" integer, "vm_memory_bytes" integer, "entered" text)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_server_stalls_started_at" ON "server_stalls" ("started_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "slow_requests" ("route" text PRIMARY KEY NOT NULL, "count" integer NOT NULL, "total_ms" integer NOT NULL, "longest_ms" integer NOT NULL, "last_at" text NOT NULL)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "slow_requests"`);
    await queryRunner.query(`DROP INDEX "IDX_server_stalls_started_at"`);
    await queryRunner.query(`DROP TABLE "server_stalls"`);
  }
}
