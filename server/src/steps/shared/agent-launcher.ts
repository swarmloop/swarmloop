import { Inject, Injectable, Optional } from '@nestjs/common';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { effortFields } from '../../contract/effort';
import { helperFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { redact } from '../../config/redact';
import { AGENT_RUNNER, readSession } from '../../agent/agent-runner';
import { chatStateRemoved } from '../../agent/agent-session';
import { LoopDetector } from '../../agent/loop-detector';
import type { AgentProcessRunner, AgentRunInput as RunnerInput, AgentRunResult } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import { AgentWorkFeed } from '../../contract/readable-log';
import type { AgentWork } from '../../contract/readable-log';
import { outputFileFor } from '../../core/attempt-output';
import { bindToStepScope, recordStepEvent } from '../../core/step-event-scope';
import { AttachmentStore } from '../../history/attachment-store';
import { sessionFileName } from '../../history/session-group';
import { NO_USAGE } from '../../agent/since-recorded';
import type { OpenScope } from '../../history/agent-call';
import { AgentCallRecorder } from './agent-call-recorder';
import type { CallLink, OpenCall } from './agent-call-recorder';
import { ResultInvalid } from './answer-errors';
import { assertNotStopped } from '../../agent/step-stopped';
import { AGENT_FOREGROUND_RULE, AGENT_LANGUAGE_RULE, readerPrompt } from './skill-prompt';
import { withAttachments } from './attachments-section';
import { withLogReads } from './outside-reads';
import { StartWaits } from './start-waits';
import { LimitFailover } from './limit-failover';
import { ModelHostUnavailable } from './model-host-unavailable';
import { AgentStoppedFromOutside } from './stopped-from-outside';
import { stoppedFromOutside } from '../../agent/agent-result';
import type { AgentRunInput } from '../../agent/agent-run-input';
import type { AgentLaunchRequest } from './agent-launch-request';
import { loopWatch, recordStart, recordWork } from './launch-work';
import { answerIsReadable, exchangeResult, resultFollowUpRequest, withAnswerErrors } from './result-exchange';
import type { LaunchResult } from './result-exchange';
import { readResult } from '../../agent-result/read-result';
import { RESULT_AS_BEFORE } from '../../agent-result/result-prompt';

function withRules(prompt: string): string {
  return `${AGENT_LANGUAGE_RULE}\n${AGENT_FOREGROUND_RULE}\n\n${prompt}`;
}

/**
 * The helper of the runtime that runs this launch, as the runtime interface takes it. Nothing when there is none, and
 * nothing for a launch with no tools: it answers from what it was told and has nothing to read. The agent keeps all its
 * read tools; the helper gets the reader's skill as its instructions.
 */
function helperInput(request: AgentLaunchRequest): Pick<AgentRunInput, 'helper'> {
  const helper = request.tools === 'none' ? undefined : helperFor(request.helpers, request.runtime);
  if (!helper) {
    return {};
  }
  return {
    helper: { model: helper.model, ...(helper.effort ? { effort: helper.effort } : {}), prompt: readerPrompt() },
  };
}

/** What runOnce has made by the time it builds the runner's input. */
interface LaunchOwn {
  sessionFile: string;
  chatId: string | null;
  call: OpenCall | undefined;
  loop: ReturnType<typeof loopWatch> | undefined;
  ending: string | undefined;
  feed: AgentWorkFeed;
  work: (item: AgentWork) => void;
}

/** Starts one agent process for a step: the session file, the prompt prefix, and the run's spend counters. */
@Injectable()
export class AgentLauncher {
  constructor(
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
    private readonly runStop: RunStop,
    @Optional() private readonly failover?: LimitFailover,
    @Optional() private readonly config?: AppConfig,
    @Optional() private readonly files?: AttachmentStore,
    @Optional() private readonly calls?: AgentCallRecorder,
    @Optional() private readonly startWaits?: StartWaits,
  ) {}

  /**
   * Launches the agent. A launch that may fail over starts on an agent whose runtime is not cooling down and moves to
   * the next agent of its role on a provider limit. The result names the agent when it is not the one asked for.
   */
  async launch(asked: AgentLaunchRequest): Promise<LaunchResult> {
    const request = withAnswerErrors(asked);
    const failover = request.failover ? this.failover : undefined;
    if (!failover) {
      return (await this.launchOn(request)).result;
    }
    let current = await this.moved(request, await failover.start(request));
    let chain: number[] = [];
    let replaces: number | undefined;
    for (;;) {
      const launched = await this.launchOn(current, replaces);
      const result = { ...launched.result, callIds: [...chain, ...(launched.result.callIds ?? [])] };
      if (!result.limit) {
        return current.runtime === request.runtime &&
          current.model === request.model &&
          current.effort === request.effort
          ? result
          : {
              ...result,
              agent: {
                runtime: current.runtime,
                model: current.model,
                ...effortFields(current),
                ...(current.helpers ? { helpers: current.helpers } : {}),
              },
            };
      }
      chain = result.callIds;
      replaces = launched.main;
      current = await this.moved(current, await failover.limited(current, result));
    }
  }

  /** Writes the row of a start the door refused, with its reason. */
  async refused(request: AgentLaunchRequest, reason: string): Promise<void> {
    await this.calls?.refused(request, reason);
  }

  /** Ends the rows a dead process left open in the scope, keeping their streamed cost. The caller settles the dead work; nothing runs on boot. */
  async closeLeftOpen(scope: OpenScope): Promise<void> {
    await this.calls?.closeLeftOpen(scope);
  }

  /** Counts the requests an attempt's stream holds that no server read while they streamed, on the attempt's rows. */
  async countStream(...args: Parameters<AgentCallRecorder['countStream']>): Promise<void> {
    await this.calls?.countStream(...args);
  }

  /** A launch on another runtime mounts the CLI of that runtime into the project image. */
  private async moved(from: AgentLaunchRequest, to: AgentLaunchRequest): Promise<AgentLaunchRequest> {
    return from.runtime === to.runtime || !to.projectFor ? to : { ...to, project: await to.projectFor(to.runtime) };
  }

  /** One launch with its follow-ups. `main` is the row of its last call, which a failover after a limit replaces. */
  private async launchOn(
    request: AgentLaunchRequest,
    replacesId?: number,
  ): Promise<{ result: LaunchResult; main?: number }> {
    const callIds: number[] = [];
    /** The launch's own rows, its first call and each follow-up; the helpers' rows are not. */
    const own: number[] = [];
    let main: number | undefined;
    const run = async (call: AgentLaunchRequest, link: CallLink): Promise<AgentRunResult> => {
      const ran = await this.runOnce(call, link);
      callIds.push(...ran.ids);
      main = ran.ids[0];
      if (main !== undefined) own.push(main);
      return ran.result;
    };
    const result = await run(request, { replacesId });
    if (result.outage) {
      throw new ModelHostUnavailable(result.outage, Object.assign({}, result, { callIds }));
    }
    this.assertNotStoppedFromOutside(request, result, callIds);
    if (request.result && answerIsReadable(request, result)) {
      const exchange = await exchangeResult(request, result, (followUp) =>
        run(resultFollowUpRequest(request, followUp), { followUp: true }),
      ).catch((error: unknown) => {
        // The reviewers that store a refused answer's visit link its rows by this.
        if (error instanceof ResultInvalid && error.result) Object.assign(error.result, { callIds });
        throw error;
      });
      if (exchange.result.outage) {
        throw new ModelHostUnavailable(exchange.result.outage, Object.assign({}, exchange.result, { callIds }));
      }
      this.assertNotStoppedFromOutside(request, exchange.result, callIds);
      if (request.call?.ties) {
        // The valid result adds the ties its actions name to the ones written when each row opened.
        const ties = await request.call.ties(exchange.value);
        for (const id of own) await this.calls?.setTies(id, ties);
      }
      return { result: { ...exchange.result, resultValue: exchange.value, callIds }, main };
    }
    return { result: { ...result, callIds }, main };
  }

  /** A container stopped from outside is a wait. A person's Stop that ended the agent the same way stays a stop. */
  private assertNotStoppedFromOutside(request: AgentLaunchRequest, result: AgentRunResult, callIds: number[]): void {
    if (result.signal && stoppedFromOutside(result) && !this.runStop.halted(request.key)) {
      throw new AgentStoppedFromOutside(result.signal, Object.assign({}, result, { callIds }));
    }
  }

  private async runOnce(
    request: AgentLaunchRequest,
    link: CallLink,
  ): Promise<{ result: AgentRunResult; ids: number[] }> {
    assertNotStopped(this.runStop, request.key);
    const directory = join(request.root, 'data');
    mkdirSync(directory, { recursive: true });
    const session = sessionStepOf(request);
    const chat = request.chatKey ?? request.key;
    const sessionFile = join(directory, sessionFileName(chat, session));
    const stored = await readSession(sessionFile, request.runtime);
    const removed = chatStateRemoved(request.root, chat, session, stored);
    const chatId = request.resume === false || removed ? null : (stored?.chatId ?? null);
    const launch = {
      runtime: request.runtime,
      model: request.model,
      tools: request.tools,
      chatId,
      resumed: chatId !== null,
    };
    recordStart(request, launch, existsSync(sessionFile), removed);
    const call = await this.calls?.begin(request, { chatId, ...link });
    if (call) {
      request.run.spentUsd = call.before.spentUsd;
    }
    const feed = new AgentWorkFeed([request.workspace, ...request.mounts.map((mount) => mount.containerPath)], () =>
      performance.now(),
    );
    const ending = request.result ? RESULT_AS_BEFORE : undefined;
    const loop = this.config ? loopWatch(new LoopDetector(this.config.env.LOOP_REPEAT), ending) : undefined;
    const work = (item: AgentWork): void => {
      const safe = item.kind === 'tool' && item.errorLine ? { ...item, errorLine: redact(item.errorLine) } : item;
      recordWork(safe);
      loop?.note(safe);
    };
    const input = this.agentInput(request, { sessionFile, chatId, call, loop, ending, feed, work });
    const result = await this.ran(request, input, call);
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
    // The owner's spend is the log's: launches that overlap on one owner never count a request twice.
    request.run.spentUsd = call ? await call.spent() : request.run.spentUsd + result.usd;
    return { result, ids: call?.ids ?? [] };
  }

  /** What the runner is given for one launch of the request: its prompt, its chat, and the spend counters of its owner. */
  private agentInput(request: AgentLaunchRequest, own: LaunchOwn): RunnerInput {
    const { sessionFile, chatId, call, loop, ending, feed, work } = own;
    const names = this.files?.names(request.key) ?? [];
    const startWaits = this.startWaits;
    return {
      loop,
      onOutput: bindToStepScope((chunk) => feed.push(chunk).forEach(work)),
      // A launch killed mid-tool leaves a block open that would hold back every later launch's events.
      onLaunchEnd: bindToStepScope(() => feed.finish().forEach(work)),
      onStartWait: startWaits ? () => startWaits.changed(request.key, request.run.recordStartWait) : undefined,
      prompt: withRules(withLogReads(withAttachments(request.prompt, names))),
      freshPrompt:
        request.freshPrompt === undefined
          ? undefined
          : withRules(withLogReads(withAttachments(request.freshPrompt, names))),
      workspace: request.workspace,
      outputFile: outputFileFor(request.root, request.key, request.step, request.run.activeAttempt),
      sessionFile,
      runtime: request.runtime,
      model: request.model,
      ...(request.effort ? { effort: request.effort } : {}),
      ...helperInput(request),
      agentCalls: request.run.agentCalls,
      spentUsd: request.run.spentUsd,
      resumeChatId: chatId,
      prior: call?.before.prior ?? NO_USAGE,
      chatSpentUsd: call?.before.chatSpentUsd ?? 0,
      onRequest: call?.onRequest,
      runKey: request.key,
      chatKey: request.chatKey,
      login: request.login,
      step: request.step,
      attemptId: request.run.activeAttempt ?? '',
      liveStep: request.liveStep,
      mounts: request.mounts,
      allowHosts: request.allowHosts,
      manifestHosts: request.manifestHosts,
      mode: request.mode,
      tools: request.tools,
      timeLimitMs: request.timeLimitMs,
      auto: request.auto,
      continuePrompt: request.continuePrompt,
      answerEnding: ending,
      resultName: request.result?.name,
      answered: this.answered(request),
      project: request.project,
    };
  }

  /** Runs the agent. The call's row ends on every path: with the result, or with the error that cut the launch short. */
  private async ran(
    request: AgentLaunchRequest,
    input: RunnerInput,
    call: OpenCall | undefined,
  ): Promise<AgentRunResult> {
    let result: AgentRunResult;
    try {
      result = await this.agent.run(input);
    } catch (error) {
      await call?.finish({ error }, false);
      throw error;
    }
    await call?.finish({ result }, this.runStop.halted(request.key));
    return result;
  }

  /** The answer is complete when its result block is valid. */
  private answered(request: AgentLaunchRequest): ((text: string) => boolean) | undefined {
    const definition = request.result;
    return definition && ((text) => readResult(definition, text).ok);
  }
}

/** The step whose session file a launch reads and writes: its own step's, unless a one-off chat names another. */
function sessionStepOf(request: AgentLaunchRequest): string {
  return request.session ?? request.step;
}
