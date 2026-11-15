import { Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../../config/env';
import { agentsFor } from '../../config/agents';
import { ERROR_CODES } from '../../contract/error-codes';
import { Clock } from '../../core/clock';
import { RunRepository } from '../../history/run.repository';
import { deriveState } from '../../history/run-state';
import { RuntimeCooldownRepository } from '../../history/runtime-cooldown.repository';
import { PersonalCredentials } from '../../auth/personal-credentials.service';
import { cooldownKeys } from './limit-failover';

/**
 * A person's Resume says the limit is over: the cooldown rows that hold a waiting run go, so every run on the same
 * runtime and credential goes on. The automatic resume comes only once a key is free, so it deletes nothing.
 */
@Injectable()
export class LimitRelease {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly cooldowns: RuntimeCooldownRepository,
    @Optional() private readonly runs?: RunRepository,
    @Optional() private readonly credentials?: PersonalCredentials,
  ) {}

  async release(key: string): Promise<void> {
    const run = await this.runs?.findRun(key);
    if (!run || run.status !== 'waiting' || deriveState(run).reason?.code !== ERROR_CODES.RUNTIME_LIMIT) return;
    const runtimes = agentsFor(this.config.env, run, run.currentStep).map((agent) => agent.runtime);
    const keys = await cooldownKeys(run, runtimes, this.runs, this.credentials);
    if ((await this.cooldowns.earliest(keys)).resumeAt > this.clock.now()) {
      await this.cooldowns.release(keys);
    }
  }
}
