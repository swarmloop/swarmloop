import { Inject, Injectable } from '@nestjs/common';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AGENT_RUNNER, readSession } from '../../agent/agent-runner';
import { chatStateRemoved } from '../../agent/agent-session';
import type { AgentProcessRunner, AgentRunResult } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import { AgentWorkFeed } from '../../contract/readable-log';
import type { AgentWork } from '../../contract/readable-log';
import { outputFileFor } from '../../core/attempt-output';
import { bindToStepScope, recordStepEvent } from '../../core/step-event-scope';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { RunEntity } from '../../history/entities';
import { sessionFileName } from '../../history/session-group';
import { VisitRepository } from '../../history/visit.repository';
import type { ProjectLaunch } from '../../sandbox/sandbox-launch';
import { assertNotStopped } from './step-stopped';
import { AGENT_FOREGROUND_RULE, AGENT_LANGUAGE_RULE } from './skill-prompt';
import { section } from './markdown-section';
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
  /** The full prompt for a fresh chat when `prompt` is a follow-up and the CLI no longer has the chat. */
  freshPrompt?: string;
  sections?: string[];
  project?: ProjectLaunch;
}

/**
 * Why a launch starts a new chat. A session file that exists but gave no chat belongs to another runtime.
 * `replay` is not told apart here: `PipelineService.replay` starts a run through the instructions document, and no flag reaches the launch.
 */
function newChatReason(
  resume: boolean | undefined,
  hasFile: boolean,
  removed: boolean,
): 'fresh by step policy' | 'runtime changed' | 'no stored chat' | 'chat state removed' {
  if (resume === false) {
    return 'fresh by step policy';
  }
  if (removed) {
    return 'chat state removed';
  }
  return hasFile ? 'runtime changed' : 'no stored chat';
}

/** An answer is complete when every named section is in it. */
function hasSections(names: string[]): (text: string) => boolean {
  return (text) => names.every((name) => section(text, name) !== null);
}

const MESSAGE_CHARS = 600;

/** Records what the agent did: a tool call, or its own text cut to 600 characters. */
function recordWork(work: AgentWork): void {
  if (work.kind === 'message') {
    recordStepEvent({ kind: 'agent.message', text: work.text.slice(0, MESSAGE_CHARS), chars: work.text.length });
    return;
  }
  const { kind: _kind, ...tool } = work;
  recordStepEvent({ kind: 'agent.tool', ...tool });
}

function withRules(prompt: string): string {
  return `${AGENT_LANGUAGE_RULE}\n${AGENT_FOREGROUND_RULE}\n\n${prompt}`;
}

/** Starts one agent process for a step: the session file, the prompt prefix, and the run's spend counters. */
@Injectable()
export class AgentLauncher {
  constructor(
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
    private readonly visits: VisitRepository,
    private readonly runStop: RunStop,
  ) {}

  async launch(request: AgentLaunchRequest): Promise<AgentRunResult> {
    assertNotStopped(this.runStop, request.key);
    const directory = join(request.root, 'data');
    mkdirSync(directory, { recursive: true });
    const sessionFile = join(directory, sessionFileName(request.key, request.step));
    const stored = await readSession(sessionFile, request.run.runtime);
    const removed = chatStateRemoved(request.root, request.key, request.step, stored);
    const chatId = request.resume === false || removed ? null : (stored?.chatId ?? null);
    const launch = { runtime: request.run.runtime, model: request.model, chatId, resumed: chatId !== null };
    recordStepEvent({
      kind: 'session.changed',
      session: chatId === null ? 'new chat' : 'same chat',
      runtime: launch.runtime,
      model: launch.model,
      reason: chatId !== null ? null : newChatReason(request.resume, existsSync(sessionFile), removed),
    });
    recordStepEvent({
      kind: 'context.manifest',
      sections: promptSections(request.prompt),
      artifacts: request.mounts.map((mount) => mount.containerPath),
      cut: [],
    });
    recordStepEvent({ kind: 'agent.launched', ...launch });
    const feed = new AgentWorkFeed([request.workspace, ...request.mounts.map((mount) => mount.containerPath)], () =>
      performance.now(),
    );
    const result = await this.agent.run({
      onOutput: bindToStepScope((chunk) => feed.push(chunk).forEach(recordWork)),
      prompt: withRules(request.prompt),
      freshPrompt: request.freshPrompt === undefined ? undefined : withRules(request.freshPrompt),
      workspace: request.workspace,
      outputFile: outputFileFor(request.root, request.key, request.step, request.run.activeAttempt),
      sessionFile,
      model: request.model,
      agentCalls: request.run.agentCalls,
      spentUsd: request.run.spentUsd,
      tokensInRun: await this.visits.tokenTotal(request.run.id),
      resumeChatId: chatId,
      groupUsd: request.resume === false ? 0 : (stored?.usd ?? 0),
      runKey: request.key,
      step: request.step,
      attemptId: request.run.activeAttempt ?? '',
      liveStep: request.liveStep,
      mounts: request.mounts,
      allowHosts: request.allowHosts,
      mode: request.mode,
      timeLimitMs: request.timeLimitMs,
      approveMcps: request.approveMcps,
      auto: request.auto,
      continuePrompt: request.continuePrompt,
      answered: request.sections && hasSections(request.sections),
      project: request.project,
    });
    feed.finish().forEach(recordWork);
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
