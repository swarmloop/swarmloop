import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CredentialCooldownEntity } from './credential-cooldown.entity';

/** How long after the provider's reset a waiting run goes on: the window is surely open again. */
export const RESUME_AFTER_RESET_MS = 60_000;

/** A runtime with the credential that hit its limit: a login, or `env` for the server's own. */
export interface CooldownKey {
  runtime: string;
  credential: string;
}

/** The credentials of runtimes that a provider limit keeps out of use. One row per runtime and credential. */
@Injectable()
export class RuntimeCooldownRepository {
  constructor(
    @InjectRepository(CredentialCooldownEntity) private readonly rows: Repository<CredentialCooldownEntity>,
  ) {}

  /** The credential of the runtime is out of use until `until`. A later end already stored stays. */
  async set(key: CooldownKey, until: number, resetKnown: boolean): Promise<void> {
    const stored = await this.rows.findOneBy(key);
    if (stored && Date.parse(stored.until) >= until) {
      return;
    }
    await this.rows.save({
      ...key,
      id: stored?.id,
      until: new Date(until).toISOString(),
      resetKnown: resetKnown ? 1 : 0,
    });
  }

  /** The runtimes among `keys` whose credential is still cooling down at `now`. Other credentials of a runtime do not count. */
  async cooling(now: number, keys: readonly CooldownKey[]): Promise<Set<string>> {
    const rows = await this.rows.find();
    const cooling = keys.filter((key) => Date.parse(this.row(rows, key)?.until ?? '') > now);
    return new Set(cooling.map((key) => key.runtime));
  }

  /**
   * When a run that waits for any of `keys` may go on: the earliest of their ends, a minute after a reset the
   * provider named. A key without a cooldown is free now, so `resumeAt` is 0.
   */
  async earliest(keys: readonly CooldownKey[]): Promise<{ until: number; resumeAt: number }> {
    const rows = await this.rows.find();
    const ends = keys.map((key) => {
      const row = this.row(rows, key);
      const until = row ? Date.parse(row.until) : 0;
      return { until, resumeAt: row ? until + (row.resetKnown === 1 ? RESUME_AFTER_RESET_MS : 0) : 0 };
    });
    return ends.reduce((first, end) => (end.resumeAt < first.resumeAt ? end : first));
  }

  private row(rows: readonly CredentialCooldownEntity[], key: CooldownKey): CredentialCooldownEntity | undefined {
    return rows.find((row) => row.runtime === key.runtime && row.credential === key.credential);
  }
}
