import { existsSync } from 'fs';
import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { recordStepEvent } from '../core/step-event-scope';
import { sessionFileName, sessionHome } from '../history/session-group';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { callsExceeded, retryCrash } from './limits';
import type { KillReason, SessionState } from './limits';
import type { AgentRunResult } from './agent-result';

/** Used when a pipeline step does not pass its own continue prompt. */
export const AGENT_CONTINUE =
  'You were stopped by the time limit before you finished. Continue this same task from where you stopped. Do not start over and do not redo edits already made. End with the sections the first message asked for.';

/** The message that goes into the same chat when the agent repeats a failing command. */
export function loopHint(command: string, errorLine: string): string {
  return `You ran the same command again and again and it failed the same way: \`${command}\`${errorLine ? ` (${errorLine})` : ''}. Try a different approach or explain why it cannot pass. Do not start over and do not redo edits already made. End with the sections the first message asked for.`;
}

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

/** True when a chat id is stored but the CLI state that holds the chat is gone, as after retention of a done run. */
export function chatStateRemoved(root: string, key: string, step: string, session: SessionState | null): boolean {
  return Boolean(session?.chatId) && !existsSync(agentStateDir(root, key, sessionHome(step)));
}

/** The stored session of a step, or null when its chat cannot be resumed: then the step starts a fresh chat. */
export async function resumableChat(
  root: string,
  key: string,
  step: string,
  runtime: string,
): Promise<SessionState | null> {
  const session = await readSession(join(root, 'data', sessionFileName(key, step)), runtime);
  return chatStateRemoved(root, key, step, session) ? null : session;
}

const MISSING_CHAT =
  /(?:chat|session|conversation)\b[^\n]{0,80}\b(?:not found|does not exist|doesn't exist|no such|could not be found)|no (?:chat|session|conversation) found/i;

/** True when the CLI answered that the chat it was asked to resume does not exist. */
export function chatMissingAnswer(attempt: AgentRunResult): boolean {
  return attempt.resumed && attempt.exitCode !== 0 && MISSING_CHAT.test(attempt.output ?? '');
}

/**
 * The CLI answered that the stored chat does not exist: its session file goes. Returns the prompt of the fresh chat
 * to start, or null when the step gave no full prompt or the fresh chat was started already.
 */
export async function dropMissingChat(
  input: { sessionFile: string; model: string; runtime: string },
  freshPrompt: string | undefined,
): Promise<string | null> {
  await rm(input.sessionFile, { force: true });
  if (freshPrompt === undefined) {
    return null;
  }
  recordStepEvent({
    kind: 'session.changed',
    session: 'new chat',
    runtime: input.runtime,
    model: input.model,
    reason: 'chat state removed',
  });
  return freshPrompt;
}

/** The output of earlier launches in a resumed chat. The log keeps it, so the new attempt is appended to it. */
export async function carriedOutput(input: { resumeChatId: string | null; outputFile: string }): Promise<string> {
  if (!input.resumeChatId) {
    return '';
  }
  return readFile(input.outputFile, 'utf8').catch(() => '');
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

/** A resumed chat that only reported orphaned tasks gets the follow-up once, without counting as an attempt. */
export function resendAfterOrphans(input: {
  attempt: AgentRunResult;
  resumed: boolean;
  resent: boolean;
  budget: LaunchBudget;
}): boolean {
  return input.resumed && input.attempt.orphanOnly === true && !input.resent && withinBudget(input.budget);
}

/** Decides whether the run launches again: a crash retry first, then a continue after a time or idle kill. */
export function relaunchPlan(input: {
  attempt: AgentRunResult;
  chatId: string | null;
  continuePrompt: string | null | undefined;
  /** The hint for the same chat after a loop kill, or null when the loop ends the step. */
  loopPrompt?: string | null;
  /** The one relaunch after an early end was already used. */
  endedEarlyUsed: boolean;
  budget: LaunchBudget;
}): Relaunch | null {
  const { attempt, budget } = input;
  if (chatMissingAnswer(attempt)) {
    return null;
  }
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
  if (attempt.chatId && attempt.killReason === 'loop' && input.loopPrompt && withinBudget(budget)) {
    return { chatId: attempt.chatId, resumed: true, prompt: input.loopPrompt };
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
