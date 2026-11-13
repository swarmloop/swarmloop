import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RuntimeCooldownEntity } from './runtime-cooldown.entity';

/** How long after the provider's reset a waiting run goes on: the window is surely open again. */
export const RESUME_AFTER_RESET_MS = 60_000;

/** The runtimes that a provider limit keeps out of use. One row per runtime for the whole server. */
@Injectable()
export class RuntimeCooldownRepository {
  constructor(@InjectRepository(RuntimeCooldownEntity) private readonly rows: Repository<RuntimeCooldownEntity>) {}

  /** The runtime is out of use until `until`. A later end already stored stays. */
  async set(runtime: string, until: number, resetKnown: boolean): Promise<void> {
    const stored = await this.rows.findOneBy({ runtime });
    if (stored && Date.parse(stored.until) >= until) {
      return;
    }
    await this.rows.save({ runtime, until: new Date(until).toISOString(), resetKnown: resetKnown ? 1 : 0 });
  }

  /** The runtimes still cooling down at `now`. */
  async cooling(now: number): Promise<Set<string>> {
    const rows = await this.rows.find();
    return new Set(rows.filter((row) => Date.parse(row.until) > now).map((row) => row.runtime));
  }

  /**
   * When a run that waits for any of `runtimes` may go on: the earliest of their ends, a minute after a reset the
   * provider named. A runtime without a cooldown is free now, so `resumeAt` is 0.
   */
  async earliest(runtimes: readonly string[]): Promise<{ until: number; resumeAt: number }> {
    const rows = await this.rows.find();
    const ends = runtimes.map((runtime) => {
      const row = rows.find((candidate) => candidate.runtime === runtime);
      const until = row ? Date.parse(row.until) : 0;
      return { until, resumeAt: row ? until + (row.resetKnown === 1 ? RESUME_AFTER_RESET_MS : 0) : 0 };
    });
    return ends.reduce((first, end) => (end.resumeAt < first.resumeAt ? end : first));
  }
}
