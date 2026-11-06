import { Inject, Injectable } from '@nestjs/common';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AGENT_RUNNER, readSession } from '../../agent/agent-runner';
import type { AgentProcessRunner, AgentRunResult } from '../../agent/agent-runner';
import { recordStepEvent } from '../../core/step-event-scope';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { RunEntity } from '../../history/entities';
import { sessionFileName } from '../../history/session-group';
import { VisitRepository } from '../../history/visit.repository';
import type { ProjectLaunch } from '../../sandbox/sandbox-launch';
import { AGENT_LANGUAGE_RULE } from './skill-prompt';
import { promptSections } from './prompt-manifest';

interface AgentLaunchRequest {
  root: string;
  run: RunEntity;
  key: string;
  step: string;
  mode: string;
  model: string;
  timeLimitMs: number;
  prompt: string;
  workspace: string;
  mounts: SandboxMount[];
  liveStep?: string;
  allowHosts?: string[];
  approveMcps?: boolean;
  auto?: boolean;
  resume?: boolean;
  continuePrompt?: string | null;
  project?: ProjectLaunch;
}

/**
 * Why a launch starts a new chat. A session file that exists but gave no chat belongs to another runtime.
 * `replay` is not told apart here: `PipelineService.replay` starts a run through the instructions document, and no flag reaches the launch.
 */
function newChatReason(
  resume: boolean | undefined,
  hasFile: boolean,
): 'fresh by step policy' | 'runtime changed' | 'no stored chat' {
  if (resume === false) {
    return 'fresh by step policy';
  }
  return hasFile ? 'runtime changed' : 'no stored chat';
}

/** Starts one agent process for a step: the session file, the prompt prefix, and the run's spend counters. */
@Injectable()
export class AgentLauncher {
  constructor(
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
    private readonly visits: VisitRepository,
  ) {}

  async launch(request: AgentLaunchRequest): Promise<AgentRunResult> {
    const directory = join(request.root, 'data');
    mkdirSync(directory, { recursive: true });
    const sessionFile = join(directory, sessionFileName(request.key, request.step));
    const stored = await readSession(sessionFile, request.run.runtime);
    const chatId = request.resume === false ? null : (stored?.chatId ?? null);
    const launch = { runtime: request.run.runtime, model: request.model, chatId, resumed: chatId !== null };
    recordStepEvent({
      kind: 'session.changed',
      session: chatId === null ? 'new chat' : 'same chat',
      runtime: launch.runtime,
      model: launch.model,
      reason: chatId !== null ? null : newChatReason(request.resume, existsSync(sessionFile)),
    });
    recordStepEvent({
      kind: 'context.manifest',
      sections: promptSections(request.prompt),
      artifacts: request.mounts.map((mount) => mount.containerPath),
      cut: [],
    });
    recordStepEvent({ kind: 'agent.launched', ...launch });
    const result = await this.agent.run({
      prompt: `${AGENT_LANGUAGE_RULE}\n\n${request.prompt}`,
      workspace: request.workspace,
      outputFile: join(directory, `${request.key}-${request.step}-output.txt`),
      sessionFile,
      model: request.model,
      agentCalls: request.run.agentCalls,
      spentUsd: request.run.spentUsd,
      tokensInRun: await this.visits.tokenTotal(request.run.id),
      resumeChatId: chatId,
      groupUsd: request.resume === false ? 0 : (stored?.usd ?? 0),
      runKey: request.key,
      step: request.step,
      liveStep: request.liveStep,
      mounts: request.mounts,
      allowHosts: request.allowHosts,
      mode: request.mode,
      timeLimitMs: request.timeLimitMs,
      approveMcps: request.approveMcps,
      auto: request.auto,
      continuePrompt: request.continuePrompt,
      project: request.project,
    });
    recordStepEvent({
      kind: 'agent.finished',
      ...launch,
      chatId: result.chatId,
      resumed: result.resumed,
      killReason: result.killReason,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      usd: result.usd,
    });
    request.run.agentCalls += result.calls;
    request.run.spentUsd += result.usd;
    return result;
  }
}
