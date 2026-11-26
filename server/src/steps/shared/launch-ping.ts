import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import type { OpenCall } from './agent-call-recorder';
import type { AgentLaunchRequest, PingCall } from './agent-launch-request';

/** Runs `use` with an output file that is gone when it ends: a ping leaves no output behind. */
export async function withThrowawayOutput<T>(use: (outputFile: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), 'swarmloop-ping-'));
  try {
    return await use(join(folder, 'output.txt'));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * What the runner is given for a ping: the chat resumed on a fork, with no tools and no session file. The prompt goes
 * in as it is, with none of the rules or sections a visit adds, so the ping writes only its own few tokens to the cache.
 */
export function pingInput(
  request: AgentLaunchRequest,
  ping: PingCall,
  call: OpenCall,
  outputFile: string,
): AgentRunInput {
  return {
    prompt: request.prompt,
    workspace: request.workspace,
    outputFile,
    sessionFile: '',
    runtime: request.runtime,
    model: request.model,
    ...(request.effort ? { effort: request.effort } : {}),
    agentCalls: request.run.agentCalls,
    spentUsd: call.before.spentUsd,
    tokensInRun: call.before.tokensInRun,
    resumeChatId: ping.chatId,
    fork: true,
    prior: call.before.prior,
    chatSpentUsd: call.before.chatSpentUsd,
    onRequest: call.onRequest,
    runKey: request.key,
    chatKey: request.chatKey,
    login: request.login,
    step: request.step,
    attemptId: '',
    liveStep: request.liveStep,
    mounts: request.mounts,
    allowHosts: request.allowHosts,
    manifestHosts: request.manifestHosts,
    mode: request.mode,
    tools: 'none',
    timeLimitMs: request.timeLimitMs,
    project: request.project,
  };
}
