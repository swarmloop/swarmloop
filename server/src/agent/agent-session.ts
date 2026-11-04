import { readFile } from 'fs/promises';
import { callsExceeded } from './limits';
import type { KillReason, SessionState } from './limits';
import type { AgentRunResult } from './agent-runner';

export type { SessionState } from './limits';

export async function readSession(path: string, runtime: string): Promise<SessionState | null> {
  try {
    const session = JSON.parse(await readFile(path, 'utf8')) as SessionState;
    return session.runtime === runtime ? session : null;
  } catch {
    return null;
  }
}

/** Another launch after time or idle, in the same loop as a crash retry. usd, tokens, and calls stay down. */
export function continueAfterLimit(input: {
  killReason: KillReason | null;
  chatId: string | null;
  halted: boolean;
  callsSoFar: number;
  maxCalls: number;
  attempts: number;
  maxLaunches: number;
  continuePrompt: string | null | undefined;
}): boolean {
  if (input.continuePrompt === null || (input.killReason !== 'time' && input.killReason !== 'idle')) {
    return false;
  }
  if (!input.chatId || input.halted || input.attempts >= input.maxLaunches) {
    return false;
  }
  return !callsExceeded(input.callsSoFar, input.maxCalls);
}

export function foldAttempt(first: AgentRunResult | null, second: AgentRunResult): AgentRunResult {
  if (!first) {
    return second;
  }
  return {
    ...second,
    tokensIn: first.tokensIn + second.tokensIn,
    tokensOut: first.tokensOut + second.tokensOut,
    usd: first.usd + second.usd,
    calls: first.calls + second.calls,
    samples: [...first.samples, ...second.samples],
    resumed: first.resumed || second.resumed,
    responseText: second.responseText || first.responseText,
    output: `${first.output ?? ''}${second.output ?? ''}`,
    chatId: second.chatId ?? first.chatId,
    durationMs: first.durationMs + second.durationMs,
    startedAt: first.startedAt,
  };
}
