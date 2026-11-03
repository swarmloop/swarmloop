import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { Logger } from '@nestjs/common';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { SystemClock } from '../core/clock';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { AgentRunInput } from './agent-runner';
import { AGENT_CONTINUE, AgentProcessRunner, readSession } from './agent-runner';
import * as limits from './limits';
import { RunStop } from './run-stop';

const PREVIOUS = 'previous-visit-transcript\n';

describe('AgentProcessRunner brief directory', () => {
  it('keeps the prompt last so a variadic --add-dir cannot swallow it', async () => {
    const { spawn } = await start('brief', [{ chunks: [chatStream('chat-9')] }], { resumeChatId: null });
    const command = (spawn.mock.calls[0]?.[0] as { command?: string[] } | undefined)?.command ?? [];
    expect(command.at(-1)).toBe('follow up');
    const at = command.indexOf('--add-dir');
    expect(command[at + 1]).toBe('/work/brief');
    expect(command[at + 2]?.startsWith('--')).toBe(true);
  });
});

describe('AgentProcessRunner resume output', () => {
  it('returns only the new stream and keeps the previous transcript in the output file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-resume-'));
    const outputFile = join(root, 'data', 'run1-implement-output.txt');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(outputFile, PREVIOUS);
    writePriceCache(root);
    const spawn = jest.fn(() => Promise.resolve(fakeChild(['visit-new-stream\n'], 0)));
    const runner = new AgentProcessRunner(config(root), new SystemClock(), sandbox(spawn), new RunStop());
    const result = await runner.run(input(root, outputFile));
    expect(result.output).toContain('visit-new-stream');
    expect(result.output).not.toContain('previous-visit-transcript');
    expect(await readFile(outputFile, 'utf8')).toMatch(/^previous-visit-transcript\n/);
  });

  it('keeps both new streams from a bare-log crash retry and leaves the previous transcript out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-retry-'));
    const outputFile = join(root, 'data', 'run1-implement-output.txt');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(outputFile, PREVIOUS);
    writePriceCache(root);
    const scripts = [
      { chunks: [] as string[], code: 1 },
      { chunks: ['second-stream\n'], code: 0 },
    ];
    const spawn = jest.fn(() => {
      const next = scripts.shift();
      if (!next) {
        return Promise.reject(new Error('unexpected spawn'));
      }
      return Promise.resolve(fakeChild(next.chunks, next.code));
    });
    const runner = new AgentProcessRunner(config(root), new SystemClock(), sandbox(spawn), new RunStop());
    const result = await runner.run(input(root, outputFile));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(result.output).toContain('process exited 1');
    expect(result.output).toContain('second-stream');
    expect(result.output).not.toContain('previous-visit-transcript');
    expect(await readFile(outputFile, 'utf8')).toMatch(/^previous-visit-transcript\n/);
  });
});

function fakeChild(chunks: string[], code: number): EventEmitter {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  for (const chunk of chunks) {
    stdout.write(chunk);
  }
  const on = child.on.bind(child);
  child.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    const returned = on(event, listener);
    if (event === 'close') {
      setImmediate(() => child.emit('close', code));
    }
    return returned;
  }) as typeof child.on;
  return Object.assign(child, { stdout, stderr, containerName: 'box', kill: () => true });
}

function sandbox(spawn: jest.Mock): SandboxService {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    spawn,
    stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
    kill: jest.fn().mockResolvedValue(undefined),
  } as unknown as SandboxService;
}

function input(root: string, outputFile: string, patch: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    prompt: 'follow up',
    workspace: root,
    outputFile,
    sessionFile: join(root, 'data', 'run1-plan-session.json'),
    model: 'm',
    agentCalls: 0,
    spentUsd: 0,
    tokensInRun: 0,
    resumeChatId: 'chat-1',
    runKey: 'run1',
    step: 'implement',
    mounts: [{ hostPath: root, containerPath: '/work/demo' }],
    mode: 'agent',
    timeLimitMs: 60_000,
    ...patch,
  };
}

function config(root: string, patch: Partial<SwarmloopEnv> = {}): AppConfig {
  return new AppConfig(
    testEnv({
      CURSOR_API_KEY: 'test-key',
      ANTHROPIC_API_KEY: 'test-key',
      MAX_AGENT_CALLS: 20,
      MAX_RUN_USD: 25,
      MODEL_RESEARCH: 'm',
      MODEL_PLAN: 'm',
      MODEL_IMPLEMENT: 'm',
      SWARMLOOP_ROOT: root,
      ...patch,
    }),
  );
}

describe('readSession', () => {
  it('keeps a chat only for the agent that opened it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-session-runtime-'));
    const path = join(root, 'session.json');
    const body = { chatId: 'c', resumed: true, completed: true, killReason: null };
    writeFileSync(path, `${JSON.stringify({ ...body, runtime: 'cursor' })}\n`);
    expect(await readSession(path, 'claude')).toBeNull();
    writeFileSync(path, `${JSON.stringify(body)}\n`);
    expect(await readSession(path, 'cursor')).toBeNull();
    writeFileSync(path, `${JSON.stringify({ ...body, runtime: 'cursor' })}\n`);
    expect((await readSession(path, 'cursor'))?.chatId).toBe('c');
  });
});

describe('AgentProcessRunner limit continuation', () => {
  it('relaunches a time kill in the same chat and returns the folded result', async () => {
    const { result, spawn, outputFile } = await start(
      'time',
      [
        { chunks: [chatStream('chat-9', 'first-stream')] },
        { chunks: [doneStream('second-stream\nsummary:\n- done\n')] },
      ],
      { resumeChatId: null, timeLimitMs: 0 },
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(promptArg(spawn.mock.calls[0])).toBe('follow up');
    expect(resumeArg(spawn.mock.calls[0])).toBeNull();
    expect(promptArg(spawn.mock.calls[1])).toBe(AGENT_CONTINUE);
    expect(resumeArg(spawn.mock.calls[1])).toBe('chat-9');
    expect(result.killReason).toBeNull();
    expect(result.chatId).toBe('chat-9');
    expect(result.calls).toBe(2);
    expect(result.responseText).toContain('summary:');
    expect(result.output).toContain('first-stream');
    expect(result.output).toContain('second-stream');
    expect(result.output).toContain('process killed: time');
    const file = await readFile(outputFile, 'utf8');
    expect(file).toContain('first-stream');
    expect(file).toContain('process started');
  });

  it('relaunches an idle kill the same way', async () => {
    const { result, spawn } = await start(
      'idle',
      [{ chunks: [chatStream('chat-9', 'idle-stream')] }, { chunks: [doneStream('idle-done\n')] }],
      { resumeChatId: null },
      { IDLE_TIMEOUT_MS: 0 },
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(promptArg(spawn.mock.calls[1])).toBe(AGENT_CONTINUE);
    expect(resumeArg(spawn.mock.calls[1])).toBe('chat-9');
    expect(result.killReason).toBeNull();
    expect(result.calls).toBe(2);
    expect(result.output).toContain('idle-stream');
    expect(result.output).toContain('idle-done');
    expect(result.output).toContain('process killed: idle');
  });

  it('uses a given continue prompt', async () => {
    const { spawn } = await start('prompt', [{ chunks: [chatStream('chat-9')] }, { chunks: [doneStream('done\n')] }], {
      resumeChatId: null,
      timeLimitMs: 0,
      continuePrompt: 'Finish the sections you already started.',
    });
    expect(promptArg(spawn.mock.calls[1])).toBe('Finish the sections you already started.');
    expect(promptArg(spawn.mock.calls[1])).not.toBe(AGENT_CONTINUE);
  });

  it('does not relaunch a usd kill', async () => {
    const spy = jest.spyOn(limits, 'judgeLimits').mockReturnValue({ kill: 'usd', warn: false });
    try {
      const { result, spawn } = await start('usd', [{ chunks: [chatStream('chat-9')] }], { resumeChatId: null });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(result.killReason).toBe('usd');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not relaunch a tokens kill', async () => {
    const { result, spawn } = await start(
      'tokens',
      [{ chunks: [chatStream('chat-9')] }],
      { resumeChatId: null },
      { STEP_TOKEN_MAX: 0 },
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.killReason).toBe('tokens');
  });

  it('logs the 80% warning once', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const spy = jest.spyOn(limits, 'judgeLimits').mockReturnValue({ kill: null, warn: true });
    try {
      await start('warn', [{ chunks: [doneStream('done\n')] }], { resumeChatId: null });
      expect(warn).toHaveBeenCalledWith('m reached 80% of its limit');
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('does not relaunch a calls kill', async () => {
    const { result, spawn } = await start('calls', [], { auto: true, agentCalls: 20 });
    expect(spawn).not.toHaveBeenCalled();
    expect(result.killReason).toBe('calls');
  });

  it('does not relaunch a halted run', async () => {
    const stop = new RunStop();
    stop.halt('run1');
    const { result, spawn } = await start(
      'halt',
      [{ chunks: [chatStream('chat-9')] }],
      { resumeChatId: null, timeLimitMs: 0 },
      {},
      stop,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.killReason).toBe('time');
  });

  it('does not relaunch when the attempt has no chat id', async () => {
    const { result, spawn } = await start('noch', [{ chunks: [chatStream(null)] }], {
      resumeChatId: null,
      timeLimitMs: 0,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.killReason).toBe('time');
    expect(result.chatId).toBeNull();
  });

  it('does not continue a chat that opts out', async () => {
    const { result, spawn } = await start('opt', [{ chunks: [chatStream('chat-9')] }], {
      resumeChatId: null,
      timeLimitMs: 0,
      continuePrompt: null,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.killReason).toBe('time');
  });

  it('counts a time kill and a crash toward the same launch cap', async () => {
    const { result, spawn } = await start(
      'cap',
      [
        { chunks: [chatStream('chat-9', 'time-1')], advance: 120_000 },
        { chunks: [chatStream('chat-9', 'crash-1')], code: 1 },
        { chunks: [chatStream('chat-9', 'time-2')], advance: 120_000 },
        { chunks: [doneStream('should-not-run')] },
      ],
      { resumeChatId: null },
    );
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(promptArg(spawn.mock.calls[0])).toBe('follow up');
    expect(resumeArg(spawn.mock.calls[0])).toBeNull();
    expect(promptArg(spawn.mock.calls[1])).toBe(AGENT_CONTINUE);
    expect(promptArg(spawn.mock.calls[2])).toBe(AGENT_CONTINUE);
    expect(resumeArg(spawn.mock.calls[2])).toBe('chat-9');
    expect(result.killReason).toBe('time');
    expect(result.calls).toBe(3);
    expect(result.output).toContain('time-1');
    expect(result.output).toContain('crash-1');
    expect(result.output).toContain('time-2');
    expect(result.output).not.toContain('should-not-run');
  });
});

async function start(
  label: string,
  steps: { chunks: string[]; code?: number; advance?: number }[],
  patch: Partial<AgentRunInput> = {},
  env: Partial<SwarmloopEnv> = {},
  stop = new RunStop(),
): Promise<{
  result: Awaited<ReturnType<AgentProcessRunner['run']>>;
  spawn: jest.Mock<Promise<EventEmitter>, unknown[]>;
  outputFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `swarmloop-agent-${label}-`));
  const outputFile = join(root, 'data', 'run1-implement-output.txt');
  mkdirSync(join(root, 'data'), { recursive: true });
  writePriceCache(root);
  const pending = [...steps];
  let now = Date.now();
  const clock = steps.some((step) => step.advance) ? jest.spyOn(Date, 'now').mockImplementation(() => now) : null;
  const spawn = jest.fn<Promise<EventEmitter>, unknown[]>(() => {
    const next = pending.shift();
    if (!next) {
      return Promise.reject(new Error('unexpected spawn'));
    }
    now += next.advance ?? 0;
    return Promise.resolve(fakeChild(next.chunks, next.code ?? 0));
  });
  const runner = new AgentProcessRunner(config(root, env), new SystemClock(), sandbox(spawn), stop);
  try {
    const result = await runner.run(input(root, outputFile, patch));
    return { result, spawn, outputFile };
  } finally {
    clock?.mockRestore();
  }
}

function promptArg(call: unknown[] | undefined): string {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  return command[command.length - 1] ?? '';
}

function resumeArg(call: unknown[] | undefined): string | null {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  const at = command.indexOf('--resume');
  return at < 0 ? null : (command[at + 1] ?? null);
}

function chatStream(chatId: string | null, note?: string): string {
  const noteLine = note ? `${JSON.stringify({ type: 'thinking', text: note })}\n` : '';
  const idLine = chatId ? `${JSON.stringify({ session_id: chatId })}\n` : '';
  return `${noteLine}${idLine}` || `${JSON.stringify({ type: 'thinking', text: 'partial' })}\n`;
}

function doneStream(text: string): string {
  return `${JSON.stringify({ type: 'result', result: text })}\n`;
}

function writePriceCache(root: string): void {
  writeFileSync(
    join(root, 'data', 'price-cache-cursor.json'),
    `${JSON.stringify({
      fetchedAt: new Date().toISOString(),
      prices: { m: { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
    })}\n`,
  );
}
