import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { replaceLogFile } from '../acp/live-output';
import { LiveHub } from '../live/live.hub';
import { SwarmloopError } from '../swarmloop-error';
import { SampleDraft } from '../history/visit';
import { agentStateDir, modelApiHosts, modelCredential, prepareStateDir, SandboxMount, sandboxUserId } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import { callsExceeded, DecisionWatch, hasModelDecision, judgeLimits, KillReason, noteDecision, priceTokens, retryCrash, SessionState, turnUsd } from './limits';
import { syncChatMode } from './chat-mode';
import { sessionGroup, sessionHome } from './session-group';
import { RunStop } from './run-stop';
import { loadPriceTable } from './prices';
import { recordLaunch } from './agent-launches';
import { addGuessedLine, emptyUsageGuess, readStreamLine, takeAnswer } from './stream';

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
}

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
  constructor(
    private readonly config: ConfigService,
    private readonly sandbox: SandboxService,
    private readonly runStop: RunStop,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    try {
      const env = readEnv(this.config);
      if (input.auto === true && callsExceeded(input.agentCalls, env.MAX_AGENT_CALLS)) {
        return this.empty(input, 'calls', 1, 0);
      }
      const command = env.RUNTIME === 'claude' ? 'claude' : 'agent';
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
      let prior = carried;
      let chatId = opening;
      let resumed = opening !== null;
      let groupUsd = input.groupUsd ?? 0;
      let merged: AgentRunResult | null = null;
      for (;;) {
        const attempt = await this.once(
          { ...input, resumeChatId: chatId, groupUsd, agentCalls: input.agentCalls + calls },
          command,
          resumed,
          prior,
        );
        merged = foldAttempt(merged, attempt);
        calls += attempt.calls;
        tries += 1;
        groupUsd += attempt.usd;
        prior = `${carried}${merged.output ?? ''}`;
        if (
          !retryCrash({
            exitCode: attempt.exitCode,
            killReason: attempt.killReason,
            halted: this.runStop.halted(input.runKey),
            callsSoFar: input.agentCalls + calls,
            maxCalls: env.MAX_AGENT_CALLS,
            attempts: tries,
            maxLaunches: env.MAX_LAUNCHES,
            decided: attempt.decided === true,
          })
        ) {
          if (!merged) {
            throw new SwarmloopError('agent returned nothing');
          }
          return merged;
        }
        chatId = attempt.chatId ?? chatId;
        resumed = chatId !== null;
      }
    } finally {
      this.live?.dropSpend(input.runKey, input.liveStep ?? input.step);
    }
  }

  private async once(input: AgentRunInput, command: string, resumed: boolean, priorOutput: string): Promise<AgentRunResult> {
    const env = readEnv(this.config);
    const userId = sandboxUserId();
    const statePath = agentStateDir(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), input.runKey, sessionHome(input.step));
    prepareStateDir(statePath, userId);
    if (command === 'agent' && input.resumeChatId) {
      syncChatMode(statePath, input.resumeChatId, input.mode);
    }
    const delivered = spillPrompt(input.prompt, statePath, input.step);
    const briefs = briefMounts(statePath, input.step, delivered.mounts);
    const args = buildAgentArgs(command, { ...input, prompt: delivered.text });
    if (briefs.length > 0 && command === 'agent') {
      args.splice(args.length - 1, 0, '--add-dir', '/work/brief');
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
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const child = await this.sandbox.spawn({
      runtime: env.RUNTIME,
      runKey: input.runKey,
      step: input.step,
      mounts: [...input.mounts, ...briefs],
      statePath,
      allowHosts: [...new Set([...(input.allowHosts ?? []), ...modelApiHosts(env.RUNTIME)])],
      env: [modelCredential(env.RUNTIME, env.CURSOR_API_KEY, env.ANTHROPIC_API_KEY)],
      command: [command, ...args],
      userId,
    });
    await recordLaunch(input.outputFile, input.runKey, input.liveStep ?? input.step);
    const baseline =
      priorOutput.length === 0 || priorOutput.endsWith('\n') ? `${priorOutput}process started\n` : `${priorOutput}\nprocess started\n`;
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
    let warned = false;
    let lastActivity = started;
    let finishedByResult = false;
    let buffer = '';
    const prices = await loadPriceTable(resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname), env.RUNTIME);

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
    const check = (): void => {
      const now = Date.now();
      const step = billed();
      const stepTokens = step.tokensIn + step.tokensOut;
      const priced = step.usd;
      const verdict = judgeLimits({
        elapsedMs: now - started,
        idleMs: now - lastActivity,
        timeLimitMs: input.timeLimitMs ?? env.REQUIREMENTS_TIMEOUT_MS,
        idleLimitMs: env.IDLE_TIMEOUT_MS,
        spentUsd: input.spentUsd,
        stepUsd: priced ?? 0,
        maxRunUsd: env.MAX_RUN_USD,
        stepUsdMax: env.STEP_USD_MAX,
        tokensInRun: input.tokensInRun,
        stepTokens,
        maxRunTokens: env.MAX_RUN_TOKENS,
        stepTokenMax: env.STEP_TOKEN_MAX,
        warned,
        enforceSpend: input.auto === true,
      });
      if (verdict.warn) {
        warned = true;
        process.stdout.write(`${input.model} reached 80% of its limit\n`);
      }
      if (verdict.kill && killReason === null && !finishedByResult) {
        killReason = verdict.kill;
        void this.writeSession(input.sessionFile, {
          chatId,
          resumed,
          completed: false,
          killReason,
          usd: sessionUsd(),
        });
        child.kill('SIGTERM');
        void this.sandbox.kill(child.containerName);
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }
    };

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
      lastActivity = Date.now();
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
        if (piece.tokensIn !== null) {
          tokensIn = piece.tokensIn;
          billedFromStream = true;
        }
        if (piece.tokensOut !== null) {
          tokensOut = piece.tokensOut;
          billedFromStream = true;
        }
        if (piece.cacheRead !== null) {
          cacheRead = piece.cacheRead;
          billedFromStream = true;
        }
        if (piece.cacheWrite !== null) {
          cacheWrite = piece.cacheWrite;
          billedFromStream = true;
        }
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
        if (piece.result && !finishedByResult) {
          finishedByResult = true;
          child.kill('SIGTERM');
          void this.sandbox.kill(child.containerName);
        }
      }
      check();
    };

    const onErr = (chunk: Buffer): void => {
      lastActivity = Date.now();
      note(chunk.toString('utf8'));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onErr);

    let sampling = false;
    const takeSample = (): void => {
      if (sampling) {
        return;
      }
      sampling = true;
      void this.sandbox
        .stats(child.containerName)
        .then((sample) => {
          samples.push({ sampledAt: new Date().toISOString(), ...sample });
          publish();
        })
        .finally(() => {
          sampling = false;
        });
    };
    takeSample();
    const timer = setInterval(() => {
      takeSample();
      check();
    }, SAMPLE_MS);
    timer.unref();

    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(code);
      };
      child.on('error', (error: NodeJS.ErrnoException) => {
        note(`${error.code ?? 'error'}: ${error.message}\n`);
        finish(1);
      });
      child.on('close', (code) => finish(code ?? 1));
      // A killed child that never closes must not leave the step running.
      const watch = setInterval(() => {
        if (killReason === null && !finishedByResult) {
          return;
        }
        clearInterval(watch);
        setTimeout(() => finish(finishedByResult ? 0 : 1), 5_000).unref();
      }, 500);
      watch.unref();
    });
    closed = true;
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    child.stdout?.off('data', onData);
    child.stderr?.off('data', onErr);
    clearInterval(timer);
    await writing;
    const finished = Date.now();
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
    const ending = finishedByResult || !killReason ? `process exited ${finishedByResult ? 0 : exitCode}` : `process killed: ${killReason}`;
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
    const now = new Date().toISOString();
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
    await writeFile(path, `${JSON.stringify(session)}\n`);
  }
}

export async function readSession(path: string): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SessionState;
  } catch {
    return null;
  }
}

/** Brief files for a chat. A code reviewer mounts its own directory. */
export function reviewBriefMount(statePath: string, step: string): SandboxMount | null {
  if (!sessionGroup(step) && !step.startsWith('code-review-')) {
    return null;
  }
  const dir = join(statePath, 'briefs');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  return { hostPath: dir, containerPath: '/work/brief', readonly: true };
}

function briefMounts(statePath: string, step: string, spilled: SandboxMount[]): SandboxMount[] {
  const review = reviewBriefMount(statePath, step);
  if (!review || spilled.some((mount) => mount.containerPath === review.containerPath)) {
    return spilled;
  }
  return [...spilled, review];
}

/** Linux rejects one argv string longer than MAX_ARG_STRLEN (128KiB). */
const ARG_BYTE_LIMIT = 100_000;

export function spillPrompt(prompt: string, statePath: string, step: string): { text: string; mounts: SandboxMount[] } {
  if (Buffer.byteLength(prompt) <= ARG_BYTE_LIMIT) {
    return { text: prompt, mounts: [] };
  }
  const name = briefName(step);
  const dir = join(statePath, 'briefs');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const file = join(dir, name);
  writeFileSync(file, prompt);
  chmodSync(file, 0o644);
  return {
    text: [`Read /work/brief/${name} and follow that assignment exactly.`, 'That file is the whole brief. Do not ask for it again.'].join('\n'),
    mounts: [{ hostPath: dir, containerPath: '/work/brief', readonly: true }],
  };
}

function briefName(step: string): string {
  const clean = step.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 80);
  const base = clean.length > 0 && clean !== '.' && clean !== '..' ? clean : 'brief';
  return `${base}.md`;
}

export function buildAgentArgs(
  command: string,
  input: {
    model: string;
    prompt: string;
    mounts: SandboxMount[];
    resumeChatId: string | null;
    mode?: string;
    approveMcps?: boolean;
  },
): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--model',
    input.model,
    '--trust',
    '--workspace',
    containerWorkspace(input.mounts),
  ];
  if (input.resumeChatId) {
    args.push('--resume', input.resumeChatId);
  }
  if ((input.mode === 'plan' || input.mode === 'ask') && command === 'agent') {
    args.push('--mode', input.mode);
  }
  if (command === 'agent' && input.mode !== 'plan' && input.mode !== 'ask') {
    args.push('--force', '--sandbox', 'disabled');
  }
  if (input.approveMcps && command === 'agent') {
    args.push('--approve-mcps');
  }
  args.push(input.prompt);
  return args;
}

/** The vendor's own terminal. A forwarded subcommand keeps the words the person typed. */
export function terminalArgs(input: {
  model: string;
  workspace: string;
  resumeChatId: string | null;
  vendor: string[];
}): string[] {
  if (input.vendor.length > 0) {
    return [...input.vendor];
  }
  const args = ['--model', input.model, '--trust', '--workspace', input.workspace];
  if (input.resumeChatId) {
    args.push('--resume', input.resumeChatId);
  }
  return args;
}

function containerWorkspace(mounts: SandboxMount[]): string {
  const workspace = mounts[0]?.containerPath;
  if (!workspace) {
    throw new SwarmloopError('sandbox mount is missing');
  }
  return workspace;
}

const SAMPLE_MS = 5_000;

function appendLine(body: string, line: string): string {
  const base = body.length === 0 || body.endsWith('\n') ? body : `${body}\n`;
  return `${base}${line}\n`;
}

function foldAttempt(first: AgentRunResult | null, second: AgentRunResult): AgentRunResult {
  if (!first) {
    return second;
  }
  return {
    ...second,
    tokensIn: first.tokensIn + second.tokensIn,
    tokensOut: first.tokensOut + second.tokensOut,
    usd: first.usd + second.usd,
    calls: first.calls + second.calls,
    samples: [...first.samples, ...second.samples],
    resumed: first.resumed || second.resumed,
    responseText: second.responseText || first.responseText,
    output: `${first.output ?? ''}${second.output ?? ''}`,
    chatId: second.chatId ?? first.chatId,
    durationMs: first.durationMs + second.durationMs,
    startedAt: first.startedAt,
  };
}
