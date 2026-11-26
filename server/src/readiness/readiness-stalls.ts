import { Injectable } from '@nestjs/common';
import { STALL_KIND_WORDS, type ServerStallKind } from '../contract/server-stall';
import { Clock } from '../core/clock';
import { ServerStallRepository } from '../history/server-stall.repository';
import type { Outcome } from './readiness-outcome';

const HOUR_MS = 3_600_000;

/** The server's stalls of the last hour as one warning; null when there were none. */
@Injectable()
export class ReadinessStalls {
  constructor(
    private readonly stalls: ServerStallRepository,
    private readonly clock: Clock,
  ) {}

  async outcome(): Promise<Outcome | null> {
    const rows = await this.stalls.since(new Date(this.clock.now() - HOUR_MS).toISOString());
    if (rows.length === 0) {
      return null;
    }
    const counts = new Map<ServerStallKind, number>();
    for (const row of rows) {
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    }
    const kinds = [...counts].sort((a, b) => b[1] - a[1]).map(([kind]) => STALL_KIND_WORDS[kind]);
    const seconds = Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / 1000);
    const times = rows.length === 1 ? '1 time' : `${rows.length} times`;
    return {
      status: 'warn',
      line: `The server stalled ${times} in the last hour, ${seconds} s in all (${kinds.join(', ')})`,
      short: `${times} in the last hour`,
      action: 'give Docker more CPUs or memory, or lower AGENTS_PARALLEL and CHECKS_PARALLEL',
      link: '/stats#statistics',
    };
  }
}
