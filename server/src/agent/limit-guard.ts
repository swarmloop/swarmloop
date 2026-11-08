import type { Logger } from '@nestjs/common';
import type { AwakeTime } from '../core/awake-time';
import type { KillReason } from './limits';
import { judgeLimits } from './limits';

export class LimitGuard {
  private warned = false;

  constructor(
    private readonly logger: Logger,
    private readonly input: {
      model: string;
      timeLimitMs: number;
      idleLimitMs: number;
      spentUsd: number;
      maxRunUsd: number;
      stepUsdMax: number | null;
      tokensInRun: number;
      maxRunTokens: number | null;
      stepTokenMax: number | null;
      auto: boolean;
    },
    private readonly state: {
      awake: AwakeTime;
      billed: () => { tokensIn: number; tokensOut: number; usd: number };
      finished: () => boolean;
      killReason: () => KillReason | null;
      kill: (reason: KillReason) => void;
    },
  ) {}

  check(): void {
    const step = this.state.billed();
    const verdict = judgeLimits({
      elapsedMs: this.state.awake.elapsedMs(),
      idleMs: this.state.awake.idleMs(),
      timeLimitMs: this.input.timeLimitMs,
      idleLimitMs: this.input.idleLimitMs,
      spentUsd: this.input.spentUsd,
      stepUsd: step.usd ?? 0,
      maxRunUsd: this.input.maxRunUsd,
      stepUsdMax: this.input.stepUsdMax,
      tokensInRun: this.input.tokensInRun,
      stepTokens: step.tokensIn + step.tokensOut,
      maxRunTokens: this.input.maxRunTokens,
      stepTokenMax: this.input.stepTokenMax,
      warned: this.warned,
      enforceSpend: this.input.auto,
    });
    if (verdict.warn) {
      this.warned = true;
      this.logger.warn(`${this.input.model} reached 80% of its limit`);
    }
    if (verdict.kill && this.state.killReason() === null && !this.state.finished()) {
      this.state.kill(verdict.kill);
    }
  }
}
