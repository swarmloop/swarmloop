import { Inject, Injectable, Optional } from '@nestjs/common';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { effortFields } from '../../contract/effort';
import { AppConfig } from '../../config/env';
import { redact } from '../../core/redact';
import { AGENT_RUNNER, readSession } from '../../agent/agent-runner';
import { chatStateRemoved } from '../../agent/agent-session';
import { LoopDetector } from '../../agent/loop-detector';
import type { AgentProcessRunner, AgentRunResult } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import { AgentWorkFeed } from '../../contract/readable-log';
import type { AgentWork } from '../../contract/readable-log';
import { outputFileFor } from '../../core/attempt-output';
import { bindToStepScope, recordStepEvent } from '../../core/step-event-scope';
import { sessionFileName } from '../../history/session-group';
import { VisitRepository } from '../../history/visit.repository';
import { assertNotStopped } from './step-stopped';
import { AGENT_FOREGROUND_RULE, AGENT_LANGUAGE_RULE } from './skill-prompt';
import { promptSections } from './prompt-manifest';
import { LimitFailover } from './limit-failover';
import type { AgentLaunchRequest } from './agent-launch-request';
import { loopWatch, newChatReason, recordWork } from './launch-work';
import { answerIsReadable, exchangeResult, resultFollowUpRequest, withAnswerErrors } from './result-exchange';
import type { LaunchResult } from './result-exchange';
import { readResult } from '../../agent-result/read-result';

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
  async launch(asked: AgentLaunchRequest): Promise<LaunchResult> {
    const request = withAnswerErrors(asked);
    const failover = request.failover ? this.failover : undefined;
    if (!failover) {
      return this.launchOn(request);
    }
    let current = await this.moved(request, await failover.start(request));
    for (;;) {
      const result = await this.launchOn(current);
      if (!result.limit) {
        return current.runtime === request.runtime &&
          current.model === request.model &&
          current.effort === request.effort
          ? result
          : { ...result, agent: { runtime: current.runtime, model: current.model, ...effortFields(current) } };
      }
      current = await this.moved(current, await failover.limited(current, result));
    }
  }

  /** A launch on another runtime mounts the CLI of that runtime into the project image. */
  private async moved(from: AgentLaunchRequest, to: AgentLaunchRequest): Promise<AgentLaunchRequest> {
    return from.runtime === to.runtime || !to.projectFor ? to : { ...to, project: await to.projectFor(to.runtime) };
  }

  private async launchOn(request: AgentLaunchRequest): Promise<LaunchResult> {
    const result = await this.runOnce(request);
    if (request.result && answerIsReadable(request, result)) {
      const exchange = await exchangeResult(request, result, (followUp) =>
        this.runOnce(resultFollowUpRequest(request, followUp)),
      );
      return { ...exchange.result, resultValue: exchange.value };
    }
    return result;
  }

  private async runOnce(request: AgentLaunchRequest): Promise<AgentRunResult> {
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
    this.recordCap(request);
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
      ...(request.effort ? { effort: request.effort } : {}),
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
      manifestHosts: request.manifestHosts,
      mode: request.mode,
      tools: request.tools,
      timeLimitMs: request.timeLimitMs,
      approveMcps: request.approveMcps,
      auto: request.auto,
      continuePrompt: request.continuePrompt,
      answered: this.answered(request),
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
    return result;
  }

  /** The answer is complete when its result block is valid. */
  private answered(request: AgentLaunchRequest): ((text: string) => boolean) | undefined {
    const definition = request.result;
    return definition && ((text) => readResult(definition, text).ok);
  }

  /** An effort the runtime could not give is said once per launch: what the model supports and what ran instead. */
  private recordCap(request: AgentLaunchRequest): void {
    const wanted = request.effortNote?.startsWith('capped:') ? request.effortNote.slice('capped:'.length) : null;
    if (wanted && request.effort) {
      recordStepEvent({
        kind: 'agent.effort_capped',
        model: request.model,
        level: request.effort,
        wanted,
        text: `${request.model} supports up to ${request.effort}; ran at ${request.effort} instead of ${wanted}.`,
      });
    }
  }
}
