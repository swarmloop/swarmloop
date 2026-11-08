import { readFile, writeFile } from 'fs/promises';
import { callsExceeded, retryCrash } from './limits';
import type { KillReason, SessionState } from './limits';
import type { AgentRunResult } from './agent-result';

/** Used when a pipeline step does not pass its own continue prompt. */
export const AGENT_CONTINUE =
  'You were stopped by the time limit before you finished. Continue this same task from where you stopped. Do not start over and do not redo edits already made. End with the sections the first message asked for.';

/** Sent when the agent's background work was killed with its answer, or a resumed chat only reported orphaned tasks. */
export const AGENT_BACKGROUND_KILLED_CONTINUE =
  'Your background work was killed when your last answer ended the process. Run the commands in the foreground and wait for them. End with the sections the first message asked for.';

export async function readSession(path: string, runtime: string): Promise<SessionState | null> {
  try {
    const session = JSON.parse(await readFile(path, 'utf8')) as SessionState;
    return session.runtime === runtime ? session : null;
  } catch {
    return null;
  }
}

export async function writeSession(path: string, runtime: string, session: SessionState): Promise<void> {
  await writeFile(path, `${JSON.stringify({ ...session, runtime })}\n`);
}

/** How many launches and calls the run has used so far, and whether it was halted. */
interface LaunchBudget {
  halted: boolean;
  callsSoFar: number;
  maxCalls: number;
  attempts: number;
  maxLaunches: number;
}

/** The next launch of the same run. A null prompt keeps the current one. */
interface Relaunch {
  chatId: string | null;
  resumed: boolean;
  prompt: string | null;
}

/** Another launch after time or idle, in the same loop as a crash retry. usd, tokens, and calls stay down. */
function continueAfterLimit(input: {
  killReason: KillReason | null;
  chatId: string | null;
  continuePrompt: string | null | undefined;
  budget: LaunchBudget;
}): boolean {
  if (input.continuePrompt === null || (input.killReason !== 'time' && input.killReason !== 'idle')) {
    return false;
  }
  return Boolean(input.chatId) && withinBudget(input.budget);
}

function withinBudget(budget: LaunchBudget): boolean {
  return !budget.halted && budget.attempts < budget.maxLaunches && !callsExceeded(budget.callsSoFar, budget.maxCalls);
}

/** Decides whether the run launches again: a crash retry first, then a continue after a time or idle kill. */
export function relaunchPlan(input: {
  attempt: AgentRunResult;
  chatId: string | null;
  continuePrompt: string | null | undefined;
  /** The one relaunch after an early end was already used. */
  endedEarlyUsed: boolean;
  budget: LaunchBudget;
}): Relaunch | null {
  const { attempt, budget } = input;
  if (
    retryCrash({
      exitCode: attempt.exitCode,
      killReason: attempt.killReason,
      decided: attempt.decided === true,
      ...budget,
    })
  ) {
    const chatId = attempt.chatId ?? input.chatId;
    return { chatId, resumed: chatId !== null, prompt: null };
  }
  if (
    attempt.chatId &&
    continueAfterLimit({
      killReason: attempt.killReason,
      chatId: attempt.chatId,
      continuePrompt: input.continuePrompt,
      budget,
    })
  ) {
    return {
      chatId: attempt.chatId,
      resumed: true,
      prompt: typeof input.continuePrompt === 'string' ? input.continuePrompt : AGENT_CONTINUE,
    };
  }
  if (
    attempt.chatId &&
    attempt.killReason === null &&
    attempt.backgroundKilled === true &&
    !input.endedEarlyUsed &&
    withinBudget(budget)
  ) {
    return { chatId: attempt.chatId, resumed: true, prompt: AGENT_BACKGROUND_KILLED_CONTINUE };
  }
  return null;
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
