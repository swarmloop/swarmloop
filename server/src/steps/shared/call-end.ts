import type { AgentRunResult } from '../../agent/agent-result';
import { StepStopped } from '../../agent/step-stopped';
import { redact } from '../../config/redact';
import type { CallEnd } from '../../history/agent-call';

/** What a call ended on: the result of its process, or the error that cut the launch short. */
export type CallOutcome = { result: AgentRunResult } | { error: unknown };

/** The words of a call that ended in a failure, as the log keeps them. */
function failure(result: AgentRunResult): Pick<CallEnd, 'errorClass' | 'errorText'> {
  return result.killReason
    ? { errorClass: 'killed', errorText: `The agent was stopped: ${result.killReason}.` }
    : { errorClass: 'exit', errorText: `The agent exited with code ${result.exitCode}.` };
}

/** How a result ended: a provider limit, an outage, a time or idle kill, a person's Stop, a failure, or done. */
function endOfResult(result: AgentRunResult, stopped: boolean): Pick<CallEnd, 'endKind'> & Partial<CallEnd> {
  if (result.limit) {
    return { endKind: 'limit', limitWindow: result.limit.window, limitResetsAt: result.limit.resetsAt };
  }
  if (result.outage) {
    return {
      endKind: 'outage',
      errorClass: 'outage',
      errorText: redact(`${result.outage.host}: ${result.outage.detail}`),
    };
  }
  if (stopped) {
    return { endKind: 'stopped', stopReason: 'person-stopped' };
  }
  if (result.killReason === 'time' || result.killReason === 'idle') {
    return { endKind: 'timed-out', ...failure(result) };
  }
  return result.killReason || result.exitCode !== 0 ? { endKind: 'failed', ...failure(result) } : { endKind: 'done' };
}

/** How the call ended, from its outcome. `stopped` tells that a person's Stop was asked while it ran. */
export function endOf(outcome: CallOutcome, stopped: boolean, now: { iso: string; durationMs: number }): CallEnd {
  if ('error' in outcome) {
    const error = outcome.error;
    return {
      finishedAt: now.iso,
      durationMs: now.durationMs,
      responseText: '',
      ...(error instanceof StepStopped
        ? { endKind: 'stopped', stopReason: 'person-stopped' }
        : {
            endKind: 'failed',
            errorClass: error instanceof Error ? error.name : 'Error',
            errorText: redact(error instanceof Error ? error.message : String(error)),
          }),
    };
  }
  const { result } = outcome;
  return {
    ...endOfResult(result, stopped),
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    responseText: result.responseText,
    chatId: result.chatId ?? undefined,
    exitCode: result.exitCode,
    killReason: result.killReason ?? undefined,
    reported: result.reported
      ? { usd: result.reported.usd, tokensIn: result.reported.tokensIn, tokensOut: result.reported.tokensOut }
      : undefined,
  };
}
