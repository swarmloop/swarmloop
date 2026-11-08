import { chmodSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { LiveHub } from '../live/live.hub';
import { SwarmloopError } from '../core/swarmloop-error';
import { Clock } from '../core/clock';
import type { AgentRuntime } from '../integrations/agent-runtime/agent-runtime';
import { CodexAuthStore, codexAuthDeps } from '../integrations/agent-runtime/codex/codex-auth';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import type { SandboxMount } from '../core/sandbox-mount';
import {
  agentStateDir,
  modelApiHosts,
  modelCredential,
  prepareStateDir,
  type ProjectLaunch,
  sandboxUserId,
} from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import type { AgentRunResult } from './agent-result';
export type { AgentRunResult } from './agent-result';
import { callsExceeded, type KillReason } from './limits';
import { syncChatMode } from './chat-mode';
import { sessionHome } from '../history/session-group';
import { RunStop } from './run-stop';
import { loadPriceTable } from './prices';
import { recordLaunch } from './agent-launches';
import { briefMounts, readOnlyTree, spillPrompt } from './agent-args';
import { AgentProcess } from './agent-process';
import { AGENT_BACKGROUND_KILLED_CONTINUE, foldAttempt, relaunchPlan, writeSession } from './agent-session';
import { AttemptMeter } from './agent-attempt';
import { LimitGuard } from './limit-guard';
import { AttemptLog } from './live-output';

export { buildAgentArgs, reviewBriefMount, spillPrompt, terminalArgs } from './agent-args';
export { AGENT_CONTINUE, readSession } from './agent-session';

export const AGENT_RUNNER = Symbol('AGENT_RUNNER');

export interface AgentRunInput {
  prompt: string;
  workspace: string;
  outputFile: string;
  sessionFile: string;
  model: string;
  agentCalls: number;
  spentUsd: number;
  tokensInRun: number;
  resumeChatId: string | null;
  runKey: string;
  step: string;
  attemptId: string;
  liveStep?: string;
  mounts: SandboxMount[];
  allowHosts?: string[];
  mode?: string;
  timeLimitMs?: number;
  approveMcps?: boolean;
  auto?: boolean;
  /** Dollars already recorded for this chat. Used only when the CLI total is cumulative. */
  groupUsd?: number;
  /**
   * Prompt for another launch after a time or idle kill.
   * Null leaves that kill as the result. Omitted uses the shared default.
   */
  continuePrompt?: string | null;
  /** Tells whether an answer holds what the step needs. Without it an answer is never treated as ended early. */
  answered?: (text: string) => boolean;
  /** Called with each chunk of the agent's output as it arrives. */
  onOutput?: (chunk: string) => void;
  /** Run in the project image with the CLI mounted into it, instead of the agent image. */
  project?: ProjectLaunch;
}

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
        return this.empty(input, 'calls', 1, 0);
      }
      const runtime = runtimeFor(env.RUNTIME);
      await this.sandbox.assertReady(env.RUNTIME);
      const carried = await this.carriedOutput(input);
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
        prior = `${carried}${merged.output ?? ''}`;
        if (
          resumed &&
          attempt.orphanOnly === true &&
          !resent &&
          !this.runStop.halted(input.runKey) &&
          !callsExceeded(input.agentCalls + calls, env.MAX_AGENT_CALLS)
        ) {
          // Orphan notifications are not an answer: ask again in this chat without counting an attempt.
          resent = true;
          chatId = attempt.chatId ?? chatId;
          prompt = AGENT_BACKGROUND_KILLED_CONTINUE;
          continue;
        }
        tries += 1;
        const relaunch = relaunchPlan({
          attempt,
          chatId,
          continuePrompt: input.continuePrompt,
          endedEarlyUsed,
          budget: {
            halted: this.runStop.halted(input.runKey),
            callsSoFar: input.agentCalls + calls,
            maxCalls: env.MAX_AGENT_CALLS,
            attempts: tries,
            maxLaunches: env.MAX_LAUNCHES,
          },
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

  /** The output of earlier launches in a resumed chat. The log keeps it, so the new attempt is appended to it. */
  private async carriedOutput(input: AgentRunInput): Promise<string> {
    if (!input.resumeChatId) {
      return '';
    }
    try {
      return await readFile(input.outputFile, 'utf8');
    } catch {
      return '';
    }
  }

  /** The subscription login, refreshed once by the server so parallel containers never race on it. */
  private async codexLogin(env: { RUNTIME: string; CODEX_AUTH: string; SWARMLOOP_ROOT?: string }): Promise<string> {
    if (env.RUNTIME !== 'codex' || env.CODEX_AUTH === '') {
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
    const prices = await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), env.RUNTIME, this.clock.now());
    const started = this.clock.now();
    const startedAt = new Date(started).toISOString();
    const workMounts = readOnlyTree(runtime.name, input.mode)
      ? input.mounts.map((mount) => ({ ...mount, readonly: true }))
      : input.mounts;
    const process = await AgentProcess.spawn(this.sandbox, this.clock, {
      runtime: env.RUNTIME,
      runKey: input.runKey,
      step: input.step,
      attemptId: input.attemptId,
      mounts: [...workMounts, ...launch.briefs],
      statePath: launch.statePath,
      allowHosts: [...new Set([...(input.allowHosts ?? []), ...modelApiHosts(env.RUNTIME)])],
      env: [
        modelCredential(
          env.RUNTIME,
          env.CURSOR_API_KEY,
          env.ANTHROPIC_API_KEY,
          env.CLAUDE_CODE_OAUTH_TOKEN,
          await this.codexLogin(env),
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
    let lastActivity = started;
    let buffer = '';
    const guard = new LimitGuard(
      this.logger,
      this.clock,
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
        started: () => started,
        lastActivity: () => lastActivity,
        billed: () => meter.billed(),
        finished: () => finishedByResult,
        killReason: () => killReason,
        kill: (reason) => {
          killReason = reason;
          void writeSession(input.sessionFile, env.RUNTIME, {
            chatId,
            resumed,
            completed: false,
            killReason,
            usd: sessionUsd(),
          });
          process.kill();
        },
      },
    );

    const onData = (chunk: Buffer): void => {
      lastActivity = this.clock.now();
      log.note(chunk.toString('utf8'));
      input.onOutput?.(chunk.toString('utf8'));
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const piece = meter.ingest(line);
        if (!piece) {
          continue;
        }
        if (piece.chatId) {
          chatId = piece.chatId;
          void writeSession(input.sessionFile, env.RUNTIME, {
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
      guard.check();
    };
    const onErr = (chunk: Buffer): void => {
      lastActivity = this.clock.now();
      log.note(chunk.toString('utf8'));
    };
    let sampling = false;
    const takeSample = (): void => {
      if (sampling) {
        return;
      }
      sampling = true;
      void this.sandbox
        .stats(process.containerName)
        .then((sample) => {
          log.addSample({ sampledAt: this.clock.iso(), ...sample });
          log.publish();
        })
        .finally(() => {
          sampling = false;
        });
    };
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
        idleLimitMs: env.IDLE_TIMEOUT_MS,
        wallLimitMs: input.timeLimitMs ?? env.REQUIREMENTS_TIMEOUT_MS,
        timeout: () => guard.check(),
      },
    );
    await log.close();
    const finished = this.clock.now();
    const priced = meter.billed();
    await writeSession(input.sessionFile, env.RUNTIME, {
      chatId,
      resumed,
      completed: finishedByResult || (killReason === null && exitCode === 0),
      killReason: finishedByResult ? null : killReason,
      usd: sessionUsd(),
    });
    meter.flush(buffer);
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
      calls: 1,
      samples: log.samples,
      durationMs: finished - started,
      startedAt,
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
    this.writeHomeFiles(runtime, statePath, userId);
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

  /** Writes the runtime's CLI home files on every launch, resumed ones included. */
  private writeHomeFiles(runtime: AgentRuntime, statePath: string, userId: number): void {
    for (const file of runtime.homeFiles()) {
      const path = join(statePath, file.path);
      prepareStateDir(dirname(path), userId);
      writeFileSync(path, file.content);
      chmodSync(path, file.mode);
    }
  }

  private empty(input: AgentRunInput, killReason: KillReason, exitCode: number, calls: number): AgentRunResult {
    const now = this.clock.iso();
    return {
      responseText: '',
      chatId: null,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      killReason,
      exitCode,
      output: '',
      resumed: false,
      calls,
      samples: [],
      durationMs: 0,
      startedAt: now,
      finishedAt: now,
    };
  }
}
