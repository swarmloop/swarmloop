import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { replaceLogFile } from '../acp/live-output';
import { LiveHub } from '../live/live.hub';
import { SwarmloopError } from '../core/swarmloop-error';
import { Clock } from '../core/clock';
import { SampleDraft } from '../history/visit';
import type { AgentRuntime } from '../integrations/agent-runtime/agent-runtime';
import { CodexAuthStore, codexAuthDeps } from '../integrations/agent-runtime/codex/codex-auth';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import {
  agentStateDir,
  modelApiHosts,
  modelCredential,
  prepareStateDir,
  type ProjectLaunch,
  SandboxMount,
  sandboxUserId,
} from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import {
  callsExceeded,
  DecisionWatch,
  hasModelDecision,
  KillReason,
  noteDecision,
  priceTokens,
  retryCrash,
  SessionState,
  turnUsd,
} from './limits';
import { syncChatMode } from './chat-mode';
import { sessionHome } from './session-group';
import { RunStop } from './run-stop';
import { loadPriceTable } from './prices';
import { recordLaunch } from './agent-launches';
import { addGuessedLine, emptyUsageGuess, readStreamLine, takeAnswer } from './stream';
import { briefMounts, spillPrompt } from './agent-args';
import { AgentProcess } from './agent-process';
import { continueAfterLimit, foldAttempt } from './agent-session';
import { LimitGuard } from './limit-guard';

export { buildAgentArgs, reviewBriefMount, spillPrompt, terminalArgs } from './agent-args';
export { readSession } from './agent-session';

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
  /** Run in the project image with the CLI mounted into it, instead of the agent image. */
  project?: ProjectLaunch;
}

/** Used when a pipeline step does not pass its own continue prompt. */
export const AGENT_CONTINUE =
  'You were stopped by the time limit before you finished. Continue this same task from where you stopped. Do not start over and do not redo edits already made. End with the sections the first message asked for.';

export interface AgentRunResult {
  responseText: string;
  chatId: string | null;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  killReason: KillReason | null;
  exitCode: number;
  output?: string;
  resumed: boolean;
  /** Set while the stream was read. A later check does not parse the log again. */
  decided?: boolean;
  calls: number;
  samples: SampleDraft[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
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
      let calls = 0;
      let tries = 0;
      let carried = '';
      const opening = input.resumeChatId;
      if (opening) {
        try {
          carried = await readFile(input.outputFile, 'utf8');
        } catch {
          carried = '';
        }
      }
      let prompt = input.prompt;
      let prior = carried;
      let chatId = opening;
      let resumed = opening !== null;
      let groupUsd = input.groupUsd ?? 0;
      let merged: AgentRunResult | null = null;
      for (;;) {
        const attempt = await this.once(
          { ...input, prompt, resumeChatId: chatId, groupUsd, agentCalls: input.agentCalls + calls },
          runtime,
          resumed,
          prior,
        );
        merged = foldAttempt(merged, attempt);
        calls += attempt.calls;
        tries += 1;
        groupUsd += attempt.usd;
        prior = `${carried}${merged.output ?? ''}`;
        const halted = this.runStop.halted(input.runKey);
        const counted = {
          halted,
          callsSoFar: input.agentCalls + calls,
          maxCalls: env.MAX_AGENT_CALLS,
          attempts: tries,
          maxLaunches: env.MAX_LAUNCHES,
        };
        if (
          retryCrash({
            exitCode: attempt.exitCode,
            killReason: attempt.killReason,
            decided: attempt.decided === true,
            ...counted,
          })
        ) {
          chatId = attempt.chatId ?? chatId;
          resumed = chatId !== null;
          continue;
        }
        if (
          attempt.chatId &&
          continueAfterLimit({
            killReason: attempt.killReason,
            chatId: attempt.chatId,
            continuePrompt: input.continuePrompt,
            ...counted,
          })
        ) {
          chatId = attempt.chatId;
          resumed = true;
          prompt = typeof input.continuePrompt === 'string' ? input.continuePrompt : AGENT_CONTINUE;
          continue;
        }
        if (!merged) {
          throw new SwarmloopError('agent returned nothing');
        }
        return merged;
      }
    } finally {
      this.live?.dropSpend(input.runKey, input.liveStep ?? input.step);
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

  private async once(
    input: AgentRunInput,
    runtime: AgentRuntime,
    resumed: boolean,
    priorOutput: string,
  ): Promise<AgentRunResult> {
    const env = this.config.env;
    const userId = sandboxUserId();
    const statePath = agentStateDir(
      resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname),
      input.runKey,
      sessionHome(input.step),
    );
    prepareStateDir(statePath, userId);
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
    const prices = await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), env.RUNTIME, this.clock.now());
    const started = this.clock.now();
    const startedAt = new Date(started).toISOString();
    const workMounts = readOnlyTree(runtime.name, input.mode)
      ? input.mounts.map((mount) => ({ ...mount, readonly: true }))
      : input.mounts;
    let lastActivity = this.clock.now();
    const process = await AgentProcess.spawn(this.sandbox, this.clock, {
      runtime: env.RUNTIME,
      runKey: input.runKey,
      step: input.step,
      mounts: [...workMounts, ...briefs],
      statePath,
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
      command: [runtime.command, ...args],
      userId,
      ...(input.project ? { project: input.project } : {}),
    });
    await recordLaunch(input.outputFile, input.runKey, input.liveStep ?? input.step);
    const baseline =
      priorOutput.length === 0 || priorOutput.endsWith('\n')
        ? `${priorOutput}process started\n`
        : `${priorOutput}\nprocess started\n`;
    await replaceLogFile(input.outputFile, baseline);
    this.live?.changed(input.runKey);
    this.live?.log({
      key: input.runKey,
      step: input.liveStep ?? input.step,
      body: baseline,
      samples: [],
      usage: { tokensIn: 0, tokensOut: 0, usd: 0 },
    });
    const samples: SampleDraft[] = [];
    let responseText = '';
    let answerLocked = false;
    let decision: DecisionWatch = { text: '', locked: false, stream: false, plain: false };
    let output = '';
    let chatId = input.resumeChatId;
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    const guess = emptyUsageGuess();
    let billedFromStream = false;
    let reportedUsd: number | null = null;
    let killReason: KillReason | null = null;
    lastActivity = started;
    let finishedByResult = false;
    let buffer = '';

    const billed = (): { tokensIn: number; tokensOut: number; usd: number } => {
      if (!billedFromStream) {
        return {
          tokensIn: guess.tokensIn,
          tokensOut: guess.tokensOut,
          usd: priceTokens(input.model, guess.tokensIn, guess.tokensOut, prices) ?? 0,
        };
      }
      const priced = priceTokens(input.model, tokensIn, tokensOut, prices, cacheRead, cacheWrite) ?? 0;
      return {
        tokensIn: tokensIn + cacheRead + cacheWrite,
        tokensOut,
        usd: turnUsd(reportedUsd, priced, input.groupUsd ?? 0, resumed),
      };
    };
    const sessionUsd = (): number => (input.groupUsd ?? 0) + billed().usd;
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
        billed,
        finished: () => finishedByResult,
        killReason: () => killReason,
        kill: (reason) => {
          killReason = reason;
          void this.writeSession(input.sessionFile, {
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

    let publishTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let writing: Promise<void> = Promise.resolve();
    const visible = (): string => `${baseline}${output}`;
    const snapshot = (): { at: string; cpu: number; memory: number }[] =>
      samples.map((sample) => ({ at: sample.sampledAt, cpu: sample.cpuPercent, memory: sample.rssBytes }));
    const usageNow = (): { tokensIn: number; tokensOut: number; usd: number } => billed();
    const publish = (): void => {
      publishTimer = null;
      const body = visible();
      if (!closed) {
        writing = writing.then(() => replaceLogFile(input.outputFile, body)).catch(() => undefined);
      }
      this.live?.log({
        key: input.runKey,
        step: input.liveStep ?? input.step,
        body: body === '' ? 'waiting for output\n' : body,
        samples: snapshot(),
        usage: usageNow(),
      });
    };
    const note = (chunk: string): void => {
      if (closed) {
        return;
      }
      output += chunk;
      if (!publishTimer) {
        publishTimer = setTimeout(publish, 80);
        publishTimer.unref();
      }
    };
    const onData = (chunk: Buffer): void => {
      lastActivity = this.clock.now();
      note(chunk.toString('utf8'));
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const piece = readStreamLine(line);
        decision = noteDecision(decision, piece, line);
        if (!piece) {
          continue;
        }
        if (piece.chatId) {
          chatId = piece.chatId;
          void this.writeSession(input.sessionFile, {
            chatId,
            resumed,
            completed: false,
            killReason: null,
            usd: sessionUsd(),
          });
        }
        const count = (current: number, next: number | null): number => {
          if (next === null) {
            return current;
          }
          billedFromStream = true;
          return piece.addUsage ? current + next : next;
        };
        tokensIn = count(tokensIn, piece.tokensIn);
        tokensOut = count(tokensOut, piece.tokensOut);
        cacheRead = count(cacheRead, piece.cacheRead);
        cacheWrite = count(cacheWrite, piece.cacheWrite);
        if (piece.reportedUsd !== null) {
          reportedUsd = piece.reportedUsd;
          billedFromStream = true;
        }
        if (!billedFromStream) {
          addGuessedLine(guess, piece);
        }
        if (piece.text || piece.finalMessage) {
          const next = takeAnswer(responseText, answerLocked, piece);
          responseText = next.text;
          answerLocked = next.locked;
        }
        if (piece.stops && !finishedByResult) {
          finishedByResult = true;
          process.kill(false);
        }
      }
      guard.check();
    };

    const onErr = (chunk: Buffer): void => {
      lastActivity = this.clock.now();
      note(chunk.toString('utf8'));
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
          samples.push({ sampledAt: this.clock.iso(), ...sample });
          publish();
        })
        .finally(() => {
          sampling = false;
        });
    };
    const exitCode = await process.wait(
      {
        data: onData,
        error: onErr,
        processError: (error) => note(`${error.code ?? 'error'}: ${error.message}\n`),
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
    closed = true;
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    await writing;
    const finished = this.clock.now();
    const priced = billed();
    await this.writeSession(input.sessionFile, {
      chatId,
      resumed,
      completed: finishedByResult || (killReason === null && exitCode === 0),
      killReason: finishedByResult ? null : killReason,
      usd: sessionUsd(),
    });
    if (buffer !== '') {
      decision = noteDecision(decision, readStreamLine(buffer), buffer);
    }
    const ending =
      finishedByResult || !killReason
        ? `process exited ${finishedByResult ? 0 : exitCode}`
        : `process killed: ${String(killReason)}`;
    output = appendLine(output, ending);
    // The step result is already in memory. A log flush that never calls back must not leave the step running.
    void replaceLogFile(input.outputFile, visible()).catch(() => undefined);
    if (publishTimer) {
      clearTimeout(publishTimer);
    }
    publish();
    return {
      responseText,
      chatId,
      tokensIn: priced.tokensIn,
      tokensOut: priced.tokensOut,
      usd: priced.usd,
      killReason: finishedByResult ? null : killReason,
      exitCode: finishedByResult ? 0 : killReason ? 1 : exitCode,
      output,
      resumed,
      decided: hasModelDecision(decision),
      calls: 1,
      samples,
      durationMs: finished - started,
      startedAt,
      finishedAt: new Date(finished).toISOString(),
    };
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

  private async writeSession(path: string, session: SessionState): Promise<void> {
    const runtime = this.config.env.RUNTIME;
    await writeFile(path, `${JSON.stringify({ ...session, runtime })}\n`);
  }
}

function appendLine(body: string, line: string): string {
  const base = body.length === 0 || body.endsWith('\n') ? body : `${body}\n`;
  return `${base}${line}\n`;
}

function readOnlyTree(runtime: string, mode: string | undefined): boolean {
  return runtime === 'codex' && (mode === 'plan' || mode === 'ask');
}
