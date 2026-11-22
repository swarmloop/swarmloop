import type { ChatUsage } from '../history/chat-usage.repository';

export const NO_USAGE: ChatUsage = { usd: 0, tokensIn: 0, tokensOut: 0 };

/**
 * A resumed CLI total covers the chat from the start of its session. Taken against the chat's previous reported
 * total, one not smaller than it is this visit's part as the difference; a smaller one is a new session, whole.
 */
export function sinceRecorded(total: number, previous: number): number {
  return total >= previous ? total - previous : total;
}

export function plusUsage(left: ChatUsage, right: ChatUsage): ChatUsage {
  return {
    usd: left.usd + right.usd,
    tokensIn: left.tokensIn + right.tokensIn,
    tokensOut: left.tokensOut + right.tokensOut,
  };
}
