import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AgentTools } from '../../integrations/agent-runtime/agent-runtime';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AppConfig } from '../../config/env';
import { redact } from '../../core/redact';
import { AGENT_RUNNER, readSession } from '../../agent/agent-runner';
import { chatStateRemoved, loopHint } from '../../agent/agent-session';
import { LoopDetector } from '../../agent/loop-detector';
import type { AgentProcessRunner, AgentRunInput, AgentRunResult } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import { AgentWorkFeed } from '../../contract/readable-log';
import type { AgentWork } from '../../contract/readable-log';
import { outputFileFor } from '../../core/attempt-output';
import { bindToStepScope, recordStepEvent } from '../../core/step-event-scope';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { RunEntity } from '../../history/entities';
import { sessionFileName } from '../../history/session-group';
import { VisitRepository } from '../../history/visit.repository';
import type { ProjectLaunch } from '../../sandbox/sandbox-launch';
import { assertNotStopped } from './step-stopped';
import { AGENT_FOREGROUND_RULE, AGENT_LANGUAGE_RULE } from './skill-prompt';
import { section } from './markdown-section';
import { promptSections } from './prompt-manifest';
import { combineAgentResults } from './agent-result';
import { parseFailureFollowUp } from './parse-failure-follow-up';
import { LimitFailover } from './limit-failover';

interface AgentLaunchRequest {
  root: string;
  run: RunEntity;
  key: string;
  step: string;
  mode: string;
  tools: AgentTools;
  runtime: RuntimeName;
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
  /** The project launch for another runtime. A launch that moves to another agent mounts that agent's CLI. */
  projectFor?: (runtime: RuntimeName) => Promise<ProjectLaunch | undefined>;
  /** The launch may move to the next agent of its role when its runtime hits a provider limit. */
  failover?: boolean;
  /** The full prompt for a new chat on another agent, when `prompt` is a follow-up. Defaults to `prompt`. */
  brief?: string;
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

/** Feeds the tool work of a launch to the loop detector and records what it finds. */
function loopWatch(detector: LoopDetector): NonNullable<AgentRunInput['loop']> & { note(work: AgentWork): void } {
  let repeated = { command: '', errorLine: '' };
  return {
    note(work) {
      if (work.kind !== 'tool') {
        return;
      }
      const { state, command, errorLine, count } = detector.note(work);
      if (state === 'watching') {
        return;
      }
      repeated = { command, errorLine };
      recordStepEvent({
        kind: 'agent.loop_hint',
        command,
        errorLine,
        count,
        ...(state === 'end' ? { ended: true } : {}),
      });
    },
    pending: () => detector.pending(),
    resumePrompt: () => (detector.resolveHint() ? loopHint(repeated.command, repeated.errorLine) : null),
  };
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
    @Optional() private readonly failover?: LimitFailover,
    @Optional() private readonly config?: AppConfig,
  ) {}

  /**
   * Launches the agent. A launch that may fail over starts on an agent whose runtime is not cooling down and moves to
   * the next agent of its role on a provider limit. The result names the agent when it is not the one asked for.
   */
  async launch(request: AgentLaunchRequest): Promise<AgentRunResult> {
    const failover = request.failover ? this.failover : undefined;
    if (!failover) {
      return this.launchOn(request);
    }
    let current = await this.moved(request, await failover.start(request));
    for (;;) {
      const result = await this.launchOn(current);
      if (!result.limit) {
        return current.runtime === request.runtime && current.model === request.model
          ? result
          : { ...result, agent: { runtime: current.runtime, model: current.model } };
      }
      current = await this.moved(current, await failover.limited(current, result));
    }
  }

  /** A launch on another runtime mounts the CLI of that runtime into the project image. */
  private async moved(from: AgentLaunchRequest, to: AgentLaunchRequest): Promise<AgentLaunchRequest> {
    return from.runtime === to.runtime || !to.projectFor ? to : { ...to, project: await to.projectFor(to.runtime) };
  }

  private async launchOn(request: AgentLaunchRequest): Promise<AgentRunResult> {
    assertNotStopped(this.runStop, request.key);
    const directory = join(request.root, 'data');
    mkdirSync(directory, { recursive: true });
    const sessionFile = join(directory, sessionFileName(request.key, request.step));
    const stored = await readSession(sessionFile, request.runtime);
    const removed = chatStateRemoved(request.root, request.key, request.step, stored);
    const chatId = request.resume === false || removed ? null : (stored?.chatId ?? null);
    const launch = {
      runtime: request.runtime,
      model: request.model,
      tools: request.tools,
      chatId,
      resumed: chatId !== null,
    };
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
    const loop = this.config ? loopWatch(new LoopDetector(this.config.env.LOOP_REPEAT)) : undefined;
    const work = (item: AgentWork): void => {
      const safe = item.kind === 'tool' && item.errorLine ? { ...item, errorLine: redact(item.errorLine) } : item;
      recordWork(safe);
      loop?.note(safe);
    };
    const result = await this.agent.run({
      loop,
      onOutput: bindToStepScope((chunk) => feed.push(chunk).forEach(work)),
      onSuspended: bindToStepScope((durationMs) => recordStepEvent({ kind: 'host.suspended', durationMs })),
      // A launch killed mid-tool leaves a block open that would hold back every later launch's events.
      onLaunchEnd: bindToStepScope(() => feed.finish().forEach(work)),
      prompt: withRules(request.prompt),
      freshPrompt: request.freshPrompt === undefined ? undefined : withRules(request.freshPrompt),
      workspace: request.workspace,
      outputFile: outputFileFor(request.root, request.key, request.step, request.run.activeAttempt),
      sessionFile,
      runtime: request.runtime,
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
      tools: request.tools,
      timeLimitMs: request.timeLimitMs,
      approveMcps: request.approveMcps,
      auto: request.auto,
      continuePrompt: request.continuePrompt,
      answered: request.sections && hasSections(request.sections),
      project: request.project,
    });
    feed.finish().forEach(work);
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
      result.exitCode === 0 &&
      !result.limit &&
      !result.backgroundKilled &&
      result.responseText !== undefined &&
      request.validate
        ? this.parseFailureFollowUp(request, result)
        : null;
    if (!followUp) {
      return result;
    }
    const retried = await this.launchOn({
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
