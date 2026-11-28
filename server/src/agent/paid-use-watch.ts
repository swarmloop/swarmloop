import { paysPastLimit } from '../contract/paid-use';
import type { AgentRuntime } from '../integrations/agent-runtime/agent-runtime';
import type { UserSettingRepository } from '../history/user-setting.repository';
import type { LimitHit } from '../integrations/agent-runtime/runtime-limit';
import type { KillReason } from './limits';

/**
 * Watches the lines of one launch for the first one that says it runs on paid usage past the plan's limit. A person who
 * allowed paid use on this runtime, and a runtime that cannot see it, are never asked.
 */
export class PaidUseWatch {
  private found: LimitHit | null = null;
  private readonly allowed: boolean;

  constructor(
    private readonly runtime: AgentRuntime,
    stored: boolean | undefined,
  ) {
    this.allowed = paysPastLimit(runtime.readsPaidUse, stored);
  }

  /** The watch of a launch run for `owner`, the person whose credential it uses; a launch on the server's own credential has no person, so paid use is off. */
  static async open(
    runtime: AgentRuntime,
    settings: UserSettingRepository | undefined,
    owner: string | null,
  ): Promise<PaidUseWatch> {
    const stored = owner === null ? undefined : (await settings?.read(owner))?.paysPastLimit;
    return new PaidUseWatch(runtime, stored);
  }

  note(line: string): void {
    if (this.allowed || this.found) {
      return;
    }
    this.found = this.runtime.paidUseLimit(line);
  }

  /** The first limit a line said, or null. */
  hit(): LimitHit | null {
    return this.found;
  }

  /** The limit the launch ended on when it was killed for paid use, else null: a launch that ended any other way ended on its own. */
  endedOn(killReason: KillReason | null): LimitHit | null {
    return killReason === 'paid use' ? this.found : null;
  }
}
