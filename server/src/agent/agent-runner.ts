import { join } from 'path';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { LiveHub } from '../live/live.hub';
import { SwarmloopError } from '../core/swarmloop-error';
import { Clock } from '../core/clock';
import { AwakeTime, SAMPLE_MS } from '../core/awake-time';
import type { AgentRuntime, AgentTools } from '../integrations/agent-runtime/agent-runtime';
import { CodexAuthStore, codexAuthDeps } from '../integrations/agent-runtime/codex/codex-auth';
import { runtimeFor, type RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import type { SandboxMount } from '../core/sandbox-mount';
import {
  agentStateDir,
  modelApiHosts,
  modelCredential,
  prepareStateDir,
  writeHomeFiles,
  sandboxUserId,
} from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import type { AgentRunInput as BaseAgentRunInput } from './agent-run-input';
import { emptyResult, type AgentRunResult } from './agent-result';
export type { AgentRunResult } from './agent-result';
import { callsExceeded, type KillReason } from './limits';
import { syncChatMode } from './chat-mode';
import { sessionHome } from '../history/session-group';
import { RunStop } from './run-stop';
import { loadPriceTable } from './prices';
import { recordLaunch } from './agent-launches';
import { briefMounts, readOnlyTree, spillPrompt } from './agent-args';
import { AgentProcess } from './agent-process';
import {
  AGENT_BACKGROUND_KILLED_CONTINUE,
  foldAttempt,
  relaunchPlan,
  resendAfterOrphans,
  writeSession,
  carriedOutput,
  chatMissingAnswer,
  dropMissingChat,
} from './agent-session';
import { AttemptMeter } from './agent-attempt';
import { OutputTail } from './output-tail';
import { LimitGuard } from './limit-guard';
import { AttemptLog } from './live-output';
import { containerSampler } from '../sandbox/container-sampler';

export { buildAgentArgs, reviewBriefMount, spillPrompt, terminalArgs } from './agent-args';
export { AGENT_CONTINUE, readSession } from './agent-session';

export const AGENT_RUNNER = Symbol('AGENT_RUNNER');

export type AgentRunInput = BaseAgentRunInput & { tools: AgentTools };

/** What one launch needs before it is spawned. */
interface Launch {
  userId: ReturnType<typeof sandboxUserId>;
  statePath: string;
  args: string[];
  briefs: SandboxMount[];
}

@Injectable()
export class AgentProcessRunner {
  private readonly logger = new Logger(AgentProcessRunner.name);
  private codexAuth: CodexAuthStore | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly sandbox: SandboxService,
    private readonly runStop: RunStop,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    try {
      const env = this.config.env;
      if (input.auto === true && callsExceeded(input.agentCalls, env.MAX_AGENT_CALLS)) {
        return emptyResult('calls', 1, 0, this.clock.iso());
      }
      const runtime = runtimeFor(input.runtime);
      await this.sandbox.assertReady(input.runtime);
      const carried = await carriedOutput(input);
      let calls = 0;
      let tries = 0;
      let prompt = input.prompt;
      let prior = carried;
      let chatId = input.resumeChatId;
      let resumed = chatId !== null;
      let groupUsd = input.groupUsd ?? 0;
      let merged: AgentRunResult | null = null;
      let endedEarlyUsed = false;
      let resent = false;
      let freshPrompt = input.freshPrompt;
      for (;;) {
        const attempt = await this.once(
          { ...input, prompt, resumeChatId: chatId, groupUsd, agentCalls: input.agentCalls + calls },
          runtime,
          resumed,
          prior,
        );
        merged = foldAttempt(merged, attempt);
        calls += attempt.calls;
        groupUsd += attempt.usd;
        if (attempt.limit) {
          // A limit is no attempt: relaunching into it only burns launches. The caller picks another agent or waits.
          return merged;
        }
        prior = `${carried}${merged.output ?? ''}`;
        const budget = {
          halted: this.runStop.halted(input.runKey),
          callsSoFar: input.agentCalls + calls,
          maxCalls: env.MAX_AGENT_CALLS,
          attempts: tries,
          maxLaunches: env.MAX_LAUNCHES,
        };
        if (resendAfterOrphans({ attempt, resumed, resent, budget })) {
          resent = true;
          chatId = attempt.chatId ?? chatId;
          prompt = AGENT_BACKGROUND_KILLED_CONTINUE;
          continue;
        }
        const fresh = chatMissingAnswer(attempt) ? await dropMissingChat(input, freshPrompt) : null;
        if (fresh !== null) {
          // The stored id points at nothing: one fresh chat with the full prompt, never a second try.
          freshPrompt = undefined;
          chatId = null;
          resumed = false;
          prompt = fresh;
          continue;
        }
        tries += 1;
        budget.attempts = tries;
        const relaunch = relaunchPlan({
          attempt,
          chatId,
          continuePrompt: input.continuePrompt,
          loopPrompt: attempt.killReason === 'loop' ? input.loop?.resumePrompt() : null,
          endedEarlyUsed,
          budget,
        });
        if (!relaunch) {
          if (!merged) {
            throw new SwarmloopError('agent returned nothing');
          }
          return merged;
        }
        endedEarlyUsed ||= relaunch.prompt === AGENT_BACKGROUND_KILLED_CONTINUE;
        chatId = relaunch.chatId;
        resumed = relaunch.resumed;
        prompt = relaunch.prompt ?? prompt;
      }
    } finally {
      this.live?.dropSpend(input.runKey, input.liveStep ?? input.step);
    }
  }

  /** The subscription login, refreshed once by the server so parallel containers never race on it. */
  private async codexLogin(runtime: RuntimeName, env: AppConfig['env']): Promise<string> {
    if (runtime !== 'codex' || env.CODEX_AUTH === '') {
      return env.CODEX_AUTH;
    }
    const dir = join(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), 'data', 'codex');
    this.codexAuth ??= new CodexAuthStore(dir, codexAuthDeps(this.clock));
    return this.codexAuth.current(env.CODEX_AUTH);
  }

  /** One launch of the process: spawn it, read its stream until it exits, and return what it did. */
  private async once(
    input: AgentRunInput,
    runtime: AgentRuntime,
    resumed: boolean,
    priorOutput: string,
  ): Promise<AgentRunResult> {
    const env = this.config.env;
    const launch = this.prepare(input, runtime, resumed);
    const prices = await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), runtime.name, this.clock.now());
    const started = this.clock.now();
    const awake = new AwakeTime(this.clock, SAMPLE_MS, input.onSuspended);
    const workMounts = readOnlyTree(runtime.name, input.mode)
      ? input.mounts.map((mount) => ({ ...mount, readonly: true }))
      : input.mounts;
    const process = await AgentProcess.spawn(this.sandbox, {
      runtime: runtime.name,
      runKey: input.runKey,
      step: input.step,
      attemptId: input.attemptId,
      mounts: [...workMounts, ...launch.briefs],
      statePath: launch.statePath,
      allowHosts: [...new Set([...(input.allowHosts ?? []), ...modelApiHosts(runtime.name)])],
      env: [
        modelCredential(
          runtime.name,
          env.CURSOR_API_KEY,
          env.ANTHROPIC_API_KEY,
          env.CLAUDE_CODE_OAUTH_TOKEN,
          await this.codexLogin(runtime.name, env),
          env.CODEX_API_KEY,
        ),
      ],
      command: [runtime.command, ...launch.args],
      userId: launch.userId,
      ...(input.project ? { project: input.project } : {}),
    });
    const step = input.liveStep ?? input.step;
    await recordLaunch(input.outputFile, input.runKey, step);
    const baseline =
      priorOutput.length === 0 || priorOutput.endsWith('\n')
        ? `${priorOutput}process started\n`
        : `${priorOutput}\nprocess started\n`;
    const meter = new AttemptMeter({
      model: input.model,
      prices,
      groupUsd: input.groupUsd ?? 0,
      resumed,
    });
    const log = new AttemptLog(input.outputFile, input.runKey, step, baseline, () => meter.billed(), this.live);
    await log.begin();
    const sessionUsd = (): number => (input.groupUsd ?? 0) + meter.billed().usd;

    let chatId = input.resumeChatId;
    let killReason: KillReason | null = null;
    let finishedByResult = false;
    let buffer = '';
    const tail = new OutputTail();
    const stop = (reason: KillReason): void => {
      killReason = reason;
      void writeSession(input.sessionFile, runtime.name, {
        chatId,
        resumed,
        completed: false,
        killReason,
        usd: sessionUsd(),
      });
      process.kill();
    };
    const guard = new LimitGuard(
      this.logger,
      {
        model: input.model,
        timeLimitMs: input.timeLimitMs ?? env.REQUIREMENTS_TIMEOUT_MS,
        idleLimitMs: env.IDLE_TIMEOUT_MS,
        spentUsd: input.spentUsd,
        maxRunUsd: env.MAX_RUN_USD,
        stepUsdMax: env.STEP_USD_MAX,
        tokensInRun: input.tokensInRun,
        maxRunTokens: env.MAX_RUN_TOKENS,
        stepTokenMax: env.STEP_TOKEN_MAX,
        auto: input.auto === true,
      },
      {
        awake,
        billed: () => meter.billed(),
        finished: () => finishedByResult,
        killReason: () => killReason,
        kill: stop,
      },
    );

    const onData = (chunk: Buffer): void => {
      awake.touch();
      log.note(chunk.toString('utf8'));
      input.onOutput?.(chunk.toString('utf8'));
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        tail.stdout(line);
        const piece = meter.ingest(line);
        if (!piece) {
          continue;
        }
        if (piece.chatId) {
          chatId = piece.chatId;
          void writeSession(input.sessionFile, runtime.name, {
            chatId,
            resumed,
            completed: false,
            killReason: null,
            usd: sessionUsd(),
          });
        }
        meter.count(piece);
        if (piece.stops && !finishedByResult) {
          finishedByResult = true;
          process.kill(false);
        }
      }
      if (killReason === null && !finishedByResult && input.loop?.pending()) {
        stop('loop');
      }
      guard.check();
    };
    const onErr = (chunk: Buffer): void => {
      awake.touch();
      log.note(chunk.toString('utf8'));
      tail.error(chunk.toString('utf8'));
    };
    const takeSample = containerSampler(this.sandbox, this.clock, process.containerName, 'agent', (sample) => {
      log.addSample(sample);
      log.publish();
    });
    const exitCode = await process.wait(
      {
        data: onData,
        error: onErr,
        processError: (error) => log.note(`${error.code ?? 'error'}: ${error.message}\n`),
        sample: takeSample,
        tick: () => guard.check(),
      },
      () => killReason !== null || finishedByResult,
      {
        time: awake,
        idleLimitMs: env.IDLE_TIMEOUT_MS,
        wallLimitMs: input.timeLimitMs ?? env.REQUIREMENTS_TIMEOUT_MS,
        timeout: () => guard.check(),
      },
    );
    await log.close();
    input.onLaunchEnd?.();
    const finished = this.clock.now();
    const priced = meter.billed();
    await writeSession(input.sessionFile, runtime.name, {
      chatId,
      resumed,
      completed: finishedByResult || (killReason === null && exitCode === 0),
      killReason: finishedByResult ? null : killReason,
      usd: sessionUsd(),
    });
    meter.flush(buffer);
    const limit = tail.limit(runtime, buffer, this.clock.now());
    const ending =
      finishedByResult || !killReason
        ? `process exited ${finishedByResult ? 0 : exitCode}`
        : `process killed: ${String(killReason)}`;
    const output = log.finish(ending);
    return {
      responseText: meter.answer(),
      chatId,
      tokensIn: priced.tokensIn,
      tokensOut: priced.tokensOut,
      usd: priced.usd,
      killReason: finishedByResult ? null : killReason,
      exitCode: finishedByResult ? 0 : killReason ? 1 : exitCode,
      output,
      resumed,
      decided: meter.decided(),
      backgroundKilled: meter.backgroundKilled(input.answered),
      orphanOnly: meter.orphanOnly(),
      ...(limit ? { limit } : {}),
      calls: 1,
      samples: log.samples,
      durationMs: finished - started,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
    };
  }

  /** Prepares the state directory, chat mode, prompt delivery, and arguments for one launch. */
  private prepare(input: AgentRunInput, runtime: AgentRuntime, resumed: boolean): Launch {
    const userId = sandboxUserId();
    const statePath = agentStateDir(
      resolveRepoRoot(this.config.env.SWARMLOOP_ROOT, __dirname),
      input.runKey,
      sessionHome(input.step),
    );
    prepareStateDir(statePath, userId);
    writeHomeFiles(runtime.homeFiles(), statePath, userId);
    if (runtime.syncsChatMode && input.resumeChatId) {
      syncChatMode(statePath, input.resumeChatId, input.mode);
    }
    const delivered = spillPrompt(input.prompt, statePath, input.step);
    const briefs = briefMounts(statePath, input.step, delivered.mounts);
    const args = runtime.printArgs({ ...input, prompt: delivered.text });
    if (briefs.length > 0) {
      args.unshift(...runtime.briefArgs());
    }
    if (!resumed) {
      this.live?.log({
        key: input.runKey,
        step: input.liveStep ?? input.step,
        body: 'waiting for output\n',
        samples: [],
        usage: { tokensIn: 0, tokensOut: 0, usd: 0 },
      });
    }
    return { userId, statePath, args, briefs };
  }
}
