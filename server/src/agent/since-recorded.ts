import type { ChatUsage } from '../history/chat-usage.repository';

export const NO_USAGE: ChatUsage = { usd: 0, tokensIn: 0, tokensOut: 0 };

/** A resumed CLI total covers the whole chat. A total at least the recorded one is that and this visit; a smaller one is this visit alone. */
export function sinceRecorded(total: number, recorded: number): number {
  return total >= recorded ? total - recorded : total;
}

/** The chat's recorded total after a visit that reported `total`, by the same rule. */
export function recordedAfter(total: number, recorded: number): number {
  return total >= recorded ? total : recorded + total;
}

export function plusUsage(left: ChatUsage, right: ChatUsage): ChatUsage {
  return {
    usd: left.usd + right.usd,
    tokensIn: left.tokensIn + right.tokensIn,
    tokensOut: left.tokensOut + right.tokensOut,
  };
}
