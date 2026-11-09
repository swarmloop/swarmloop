import { Inject, Injectable, Optional } from '@nestjs/common';
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
import { DocumentRepository } from '../../history/document.repository';
import { VisitRepository } from '../../history/visit.repository';
import { prepareRunImages } from '../../environment/run-images';
import type { RunImages } from '../../sandbox/image-resolver';
import { SandboxService } from '../../sandbox/sandbox.service';
import type { ProjectLaunch } from '../../sandbox/sandbox-launch';
import { assertNotStopped } from './step-stopped';
import { AGENT_FOREGROUND_RULE, AGENT_LANGUAGE_RULE } from './skill-prompt';
import { section } from './markdown-section';
import { promptSections } from './prompt-manifest';
import { combineAgentResults } from './agent-result';
import { parseFailureFollowUp } from './parse-failure-follow-up';

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
  /** Validates the completed answer before returning it. A missing or empty named section gets one focused retry. */
  validate?: (text: string, output: string | undefined) => void;
  parseFailureEnding?: string | null;
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
    @Optional() private readonly sandbox?: SandboxService,
    @Optional() private readonly documents?: DocumentRepository,
  ) {}

  /**
   * Makes the images of the run ready before its first launch. A Stop seen before or during the pull ends it
   * without a launch. Not an attempt: no counter of the run moves.
   */
  async prepareImages(run: RunEntity): Promise<RunImages | undefined> {
    if (!this.sandbox || !this.documents) {
      return undefined;
    }
    assertNotStopped(this.runStop, run.key);
    const images = await prepareRunImages(this.sandbox, this.documents, run);
    assertNotStopped(this.runStop, run.key);
    return images;
  }

  async launch(request: AgentLaunchRequest): Promise<AgentRunResult> {
    assertNotStopped(this.runStop, request.key);
    await this.prepareImages(request.run);
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
      onSuspended: bindToStepScope((durationMs) => recordStepEvent({ kind: 'host.suspended', durationMs })),
      // A launch killed mid-tool leaves a block open that would hold back every later launch's events.
      onLaunchEnd: bindToStepScope(() => feed.finish().forEach(recordWork)),
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
    const followUp =
      result.exitCode === 0 && !result.backgroundKilled && result.responseText !== undefined && request.validate
        ? this.parseFailureFollowUp(request, result)
        : null;
    if (!followUp) {
      return result;
    }
    const retried = await this.launch({
      ...request,
      prompt: followUp,
      freshPrompt: request.freshPrompt ?? request.prompt,
      continuePrompt: null,
      resume: undefined,
      validate: undefined,
      parseFailureEnding: null,
    });
    return combineAgentResults([result, retried]) ?? retried;
  }

  private parseFailureFollowUp(request: AgentLaunchRequest, result: AgentRunResult): string | null {
    try {
      request.validate?.(result.responseText, result.output);
      return null;
    } catch (error) {
      return parseFailureFollowUp(error, request.parseFailureEnding ?? null);
    }
  }
}
