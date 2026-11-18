import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { ServerStallEntity, SlowRequestEntity } from './server-stall.entities';

export type ServerStallDraft = Omit<ServerStallEntity, 'id'>;

/** The server's stalls. Records are only added. */
@Injectable()
export class ServerStallRepository {
  constructor(@InjectRepository(ServerStallEntity) private readonly rows: Repository<ServerStallEntity>) {}

  async record(draft: ServerStallDraft): Promise<void> {
    await this.rows.insert(draft);
  }

  /** The stalls that started at or after `iso`, oldest first. */
  since(iso: string): Promise<ServerStallEntity[]> {
    return this.rows.find({ where: { startedAt: MoreThanOrEqual(iso) }, order: { startedAt: 'ASC', id: 'ASC' } });
  }
}

/** Slow requests counted per route. */
@Injectable()
export class SlowRequestRepository {
  constructor(@InjectRepository(SlowRequestEntity) private readonly rows: Repository<SlowRequestEntity>) {}

  async add(route: string, ms: number, at: string): Promise<void> {
    await this.rows.query(
      `INSERT INTO "slow_requests" ("route", "count", "total_ms", "longest_ms", "last_at") VALUES (?, 1, ?, ?, ?)
       ON CONFLICT("route") DO UPDATE SET "count" = "count" + 1, "total_ms" = "total_ms" + excluded."total_ms",
       "longest_ms" = max("longest_ms", excluded."longest_ms"), "last_at" = excluded."last_at"`,
      [route, ms, ms, at],
    );
  }
}
