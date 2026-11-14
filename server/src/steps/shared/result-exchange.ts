import { readResult } from '../../agent-result/read-result';
import { resultFollowUp } from '../../agent-result/result-follow-up';
import type { AgentRunResult } from '../../agent/agent-runner';
import { ResultInvalid } from './answer-errors';
import { combineAgentResults } from './agent-result';
import type { AgentLaunchRequest } from './agent-launch-request';

const MAX_RESULT_FOLLOW_UPS = 2;

interface ResultExchange {
  result: AgentRunResult;
  value: unknown;
}

/** The errors of one answer: the result block against the schema, then the checks the server makes on the value. */
function errorsOf(request: AgentLaunchRequest, text: string): { value?: unknown; errors: string[] } {
  if (!request.result) {
    return { errors: [] };
  }
  const read = readResult(request.result, text);
  if (!read.ok) {
    return { errors: read.errors };
  }
  return { value: read.value, errors: request.check?.(read.value) ?? [] };
}

/** An answer of a clean exit is read; a limit, a kill or a bad exit is handled by the caller as before. */
export function answerIsReadable(request: AgentLaunchRequest, result: AgentRunResult): boolean {
  return Boolean(request.result) && result.exitCode === 0 && !result.limit && !result.backgroundKilled;
}

/**
 * Reads the result block of the answer. A missing or invalid block, or a failed check, sends every error back in the
 * same chat, at most twice; after that the step fails with the errors of the last answer.
 */
export async function exchangeResult(
  request: AgentLaunchRequest,
  first: AgentRunResult,
  again: (followUp: string) => Promise<AgentRunResult>,
): Promise<ResultExchange> {
  const results = [first];
  for (let sent = 0; ; sent += 1) {
    const last = results[results.length - 1];
    const { value, errors } = errorsOf(request, last.responseText);
    if (errors.length === 0) {
      return { result: combineAgentResults(results) ?? last, value };
    }
    if (sent === MAX_RESULT_FOLLOW_UPS) {
      const result = combineAgentResults(results) ?? last;
      throw new ResultInvalid(errors, result.output, result);
    }
    const next = await again(resultFollowUp(errors));
    results.push(next);
    if (!answerIsReadable(request, next)) {
      return { result: combineAgentResults(results) ?? next, value: undefined };
    }
  }
}

/** The result and the value its block held; the value is absent when the launch ended on a limit or a kill. */
export type LaunchResult = AgentRunResult & { resultValue?: unknown };

/** The request of a follow-up: the same chat, the errors, and the full prompt with them when the chat is gone. */
export function resultFollowUpRequest(request: AgentLaunchRequest, followUp: string): AgentLaunchRequest {
  return {
    ...request,
    prompt: followUp,
    freshPrompt: `${request.freshPrompt ?? request.prompt}\n\n${followUp}`,
    continuePrompt: null,
    resume: undefined,
  };
}

/** A launch that follows a failed answer starts by telling the agent every error of it. */
export function withAnswerErrors(request: AgentLaunchRequest): AgentLaunchRequest {
  if (!request.answerErrors?.length) {
    return request;
  }
  const followUp = resultFollowUp(request.answerErrors);
  const append = (prompt: string): string => `${prompt}\n\n${followUp}`;
  const briefFor = request.briefFor;
  return {
    ...request,
    answerErrors: undefined,
    prompt: append(request.prompt),
    freshPrompt: append(request.freshPrompt ?? request.prompt),
    brief: request.brief === undefined ? undefined : append(request.brief),
    briefFor: briefFor && ((runtime) => append(briefFor(runtime))),
  };
}
