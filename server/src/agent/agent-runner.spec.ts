import { EventEmitter } from 'events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { Logger } from '@nestjs/common';
import { parseAgentList } from '../config/agents';
import { AppConfig, type SwarmloopEnv } from '../config/env';
import { testEnv } from '../config/env.spec-helpers';
import { SystemClock } from '../core/clock';
import type { LiveHub } from '../live/live.hub';
import type { SandboxService } from '../sandbox/sandbox.service';
import type { AgentRunInput } from './agent-runner';
import { AGENT_CONTINUE, AgentProcessRunner, readSession } from './agent-runner';
import { AGENT_BACKGROUND_KILLED_CONTINUE } from './agent-session';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { sessionHome } from '../history/session-group';
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

describe('AgentProcessRunner agent runtime', () => {
  it('launches the runtime of the input with its own credential and egress hosts, not the one of RUNTIME', async () => {
    const { spawn } = await start(
      'other-runtime',
      [{ chunks: [chatStream('chat-9')] }],
      { resumeChatId: null, runtime: 'claude' },
      { CURSOR_API_KEY: 'cursor-key', ANTHROPIC_API_KEY: 'anthropic-key' },
    );
    const launch = spawn.mock.calls[0]?.[0] as {
      runtime: string;
      command: string[];
      env: { name: string; value: string }[];
      allowHosts: string[];
    };
    expect(launch.runtime).toBe('claude');
    expect(launch.command[0]).toBe('claude');
    expect(launch.env).toEqual([{ name: 'ANTHROPIC_API_KEY', value: 'anthropic-key' }]);
    expect(launch.allowHosts).toContain('api.anthropic.com');
  });

  it('launches a Claude agent with an effort at that level and clears the env override', async () => {
    const { spawn } = await start('claude-effort', [{ chunks: [chatStream('chat-9')] }], {
      resumeChatId: null,
      runtime: 'claude',
      effort: 'high',
    });
    const launch = spawn.mock.calls[0]?.[0] as { command: string[]; unsetEnv: string[] };
    expect(launch.command.join(' ')).toContain('--effort high');
    expect(launch.unsetEnv).toEqual(['CLAUDE_CODE_EFFORT_LEVEL']);
  });

  it('launches a Codex agent with an effort through its config flag', async () => {
    const { spawn } = await start(
      'codex-effort',
      [{ chunks: [chatStream('chat-9')] }],
      { resumeChatId: null, runtime: 'codex', effort: 'high' },
      { CODEX_API_KEY: 'codex-key' },
    );
    const launch = spawn.mock.calls[0]?.[0] as { command: string[]; unsetEnv: string[] };
    expect(launch.command.join(' ')).toContain('-c model_reasoning_effort=high');
    expect(launch.unsetEnv).toEqual([]);
  });

  it('launches an agent without an effort with no effort flag and no env change', async () => {
    const { spawn } = await start('no-effort', [{ chunks: [chatStream('chat-9')] }], {
      resumeChatId: null,
      runtime: 'claude',
    });
    const launch = spawn.mock.calls[0]?.[0] as { command: string[]; unsetEnv: string[] };
    expect(launch.command).not.toContain('--effort');
    expect(launch.unsetEnv).toEqual([]);
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

describe('AgentProcessRunner wait line', () => {
  it('records no host suspension for an agent that starts at once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-suspended-'));
    const outputFile = join(root, 'data', 'run1-implement-output.txt');
    mkdirSync(join(root, 'data'), { recursive: true });
    writePriceCache(root);
    const spawn = jest.fn(() => Promise.resolve(fakeChild(['agent-output\n'], 0)));
    const suspended: number[] = [];
    const runner = new AgentProcessRunner(config(root), new SystemClock(), sandbox(spawn), new RunStop());
    const result = await runner.run({
      ...input(root, outputFile, { resumeChatId: null }),
      onSuspended: (ms) => suspended.push(ms),
    });
    expect(suspended).toEqual([]);
    expect(result.output).toContain('agent-output');
  });

  it('writes no wait line when the agent starts at once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-nowait-'));
    const outputFile = join(root, 'data', 'run1-implement-output.txt');
    mkdirSync(join(root, 'data'), { recursive: true });
    writePriceCache(root);
    const spawn = jest.fn(() => Promise.resolve(fakeChild(['agent-output\n'], 0)));
    const live = { log: jest.fn(), dropSpend: jest.fn(), changed: jest.fn() };
    const runner = new AgentProcessRunner(
      config(root),
      new SystemClock(),
      sandbox(spawn),
      new RunStop(),
      live as unknown as LiveHub,
    );
    await runner.run(input(root, outputFile, { resumeChatId: null }));
    const bodies = live.log.mock.calls.map(([entry]: [{ body: string }]) => entry.body);
    expect(bodies.some((body) => body.startsWith('waiting for machine resources'))).toBe(false);
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
    runtime: 'cursor',
    model: 'm',
    agentCalls: 0,
    spentUsd: 0,
    tokensInRun: 0,
    resumeChatId: 'chat-1',
    runKey: 'run1',
    step: 'implement',
    attemptId: 'attempt-1',
    mounts: [{ hostPath: root, containerPath: '/work/demo' }],
    mode: 'agent',
    tools: 'write',
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
      AGENTS_PLAN: 'cursor:m',
      AGENTS_IMPLEMENT: 'cursor:m',
      AGENTS_REVIEW: 'cursor:m',
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

/** What each runtime's CLI ends a launch with when the provider's limit is reached, with the reset it names. */
const LIMIT_SAMPLES = [
  {
    runtime: 'claude',
    // The reviewer output of run-mw85iykj: the text is the answer, so no step finds a decision in it.
    stream: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat-r03' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 9:50pm (UTC)" }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: "You've hit your 5-hour limit · resets 9:50pm (UTC)",
        session_id: 'chat-r03',
      }),
    ].join('\n'),
    limit: { window: '5-hour', resetsAt: '2026-11-08T21:50:00.000Z' },
  },
  {
    runtime: 'codex',
    stream: `${JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:50 PM." } })}\n`,
    limit: { window: 'usage', resetsAt: '2026-11-08T21:50:00.000Z' },
  },
  {
    runtime: 'cursor',
    stream: `${JSON.stringify({ type: 'result', is_error: true, result: "You've hit your usage limit" })}\n`,
    limit: { window: 'usage' },
  },
] as const;

describe('AgentProcessRunner provider limit', () => {
  const NOW = Date.parse('2026-11-08T18:42:00Z');

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(LIMIT_SAMPLES)(
    'returns the $runtime limit with its reset and launches once, because a limit is no attempt',
    async ({ runtime, stream, limit }) => {
      const { result, spawn } = await start(
        `limit-${runtime}`,
        [{ chunks: [stream], code: 1 }],
        { resumeChatId: null, runtime },
        { MAX_LAUNCHES: 3, CODEX_API_KEY: 'codex-key' },
      );
      expect(result.limit).toEqual(limit);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it('does not take an auth error or a full context for a limit', async () => {
    for (const text of ['Invalid API key · Please run /login', 'Prompt is too long']) {
      const { result } = await start(
        'not-a-limit',
        [{ chunks: [`${JSON.stringify({ type: 'result', is_error: true, result: text })}\n`], code: 1 }],
        { resumeChatId: null, runtime: 'claude' },
        { MAX_LAUNCHES: 1 },
      );
      expect(result.limit).toBeUndefined();
    }
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

  it('keeps the prompt on a crash retry', async () => {
    const { spawn } = await start('crash', [{ chunks: [], code: 1 }, { chunks: [doneStream('done\n')] }], {
      resumeChatId: null,
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(promptArg(spawn.mock.calls[1])).toBe('follow up');
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
        { chunks: [chatStream('chat-9', 'time-1')], advance: 10_000 },
        { chunks: [chatStream('chat-9', 'crash-1')], code: 1 },
        { chunks: [chatStream('chat-9', 'time-2')], advance: 10_000 },
        { chunks: [doneStream('should-not-run')] },
      ],
      { resumeChatId: null, timeLimitMs: 10_000 },
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

describe('AgentProcessRunner ended early', () => {
  const claude = {
    AGENTS_PLAN: 'claude:m',
    AGENTS_IMPLEMENT: 'claude:m',
    AGENTS_REVIEW: 'claude:m',
  } as const;
  const answered = doneStream('implementation:\n- changed it\n');

  it('relaunches once in the same chat with the foreground follow-up when background work was killed', async () => {
    const { result, spawn } = await start(
      'early',
      [{ chunks: [killedStream('chat-9')] }, { chunks: [answered] }],
      { resumeChatId: null, answered: (text) => text.includes('implementation:') },
      claude,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(promptArg(spawn.mock.calls[1])).toBe(AGENT_BACKGROUND_KILLED_CONTINUE);
    expect(resumeArg(spawn.mock.calls[1])).toBe('chat-9');
    expect(result.calls).toBe(2);
    expect(result.backgroundKilled).toBe(false);
    expect(result.responseText).toContain('implementation:');
  });

  it('relaunches only once and reports the kill when the second answer ends early too', async () => {
    const { result, spawn } = await start(
      'early-twice',
      [{ chunks: [killedStream('chat-9')] }, { chunks: [killedStream('chat-9')] }, { chunks: [answered] }],
      { resumeChatId: null, answered: (text) => text.includes('implementation:') },
      claude,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(result.backgroundKilled).toBe(true);
  });

  it('does not treat an answer as ended early when the launch names no sections', async () => {
    const { result, spawn } = await start('early-none', [{ chunks: [killedStream('chat-9')] }], {}, claude);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.backgroundKilled).toBe(false);
  });

  it('starts one fresh chat with the full prompt when the CLI does not have the stored chat', async () => {
    const missing = { chunks: ['Error: chat chat-1 not found\n'], code: 1 };
    const { result, spawn, root } = await start('missing-chat', [missing, { chunks: [doneStream('done')] }], {
      freshPrompt: 'the full prompt',
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(resumeArg(spawn.mock.calls[0])).toBe('chat-1');
    expect(resumeArg(spawn.mock.calls[1])).toBeNull();
    expect(promptArg(spawn.mock.calls[1])).toContain('the full prompt');
    expect(result.exitCode).toBe(0);
    expect(storedChat(root)).not.toBe('chat-1');
  });

  it('does not retry a missing chat when the step gave no full prompt', async () => {
    const { spawn, root } = await start('missing-plain', [{ chunks: ['Error: chat chat-1 not found\n'], code: 1 }]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, 'data', 'run1-plan-session.json'))).toBe(false);
  });

  it('does not count an orphan-only resumed output as an attempt', async () => {
    const orphan = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'b1',
      status: 'stopped',
      summary: 'Orphaned by a previous Claude Code process exit',
    };
    const { result, spawn } = await start(
      'orphan',
      [{ chunks: [`${JSON.stringify(orphan)}\n${doneStream('')}`] }, { chunks: [answered] }],
      { resumeChatId: 'chat-1', answered: (text) => text.includes('implementation:') },
      { ...claude, MAX_LAUNCHES: 1 },
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(promptArg(spawn.mock.calls[1])).toBe(AGENT_BACKGROUND_KILLED_CONTINUE);
    expect(resumeArg(spawn.mock.calls[1])).toBe('chat-1');
    expect(result.responseText).toContain('implementation:');
  });

  const note = { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'stopped' };
  it.each([
    [
      'the 2.1.319 wording',
      { ...note, summary: "Background shell command didn't finish before the previous session ended" },
    ],
    ['no summary', note],
    ['a killed status', { ...note, status: 'killed' }],
    ['a task_updated entry', { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'stopped' } }],
    [
      'a background_tasks_changed entry',
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'b1', status: 'stopped' }] },
    ],
  ])('does not count an orphan-only resumed output as an attempt: %s', async (_label, event) => {
    const { result, spawn } = await start(
      'orphan-variant',
      [{ chunks: [`${chatStream('chat-1')}${JSON.stringify(event)}\n${doneStream('')}`] }, { chunks: [answered] }],
      { resumeChatId: 'chat-1', answered: (text) => text.includes('implementation:') },
      { ...claude, MAX_LAUNCHES: 1 },
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(promptArg(spawn.mock.calls[1])).toBe(AGENT_BACKGROUND_KILLED_CONTINUE);
    expect(resumeArg(spawn.mock.calls[1])).toBe('chat-1');
    expect(result.responseText).toContain('implementation:');
  });

  it('does not treat a resumed output with assistant text as orphan-only', async () => {
    const talk = { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } };
    const { result, spawn } = await start(
      'orphan-text',
      [{ chunks: [`${JSON.stringify(note)}\n${JSON.stringify(talk)}\n${doneStream('working on it')}`] }],
      { resumeChatId: 'chat-1' },
      { ...claude, MAX_LAUNCHES: 1 },
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.orphanOnly).toBe(false);
  });

  it.each([
    ['a running notification', { ...note, status: 'running' }],
    [
      'an assistant line before an empty result',
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    ],
  ])('does not treat %s as orphan-only', async (_label, event) => {
    const { spawn } = await start(
      'orphan-other',
      [{ chunks: [`${JSON.stringify(note)}\n${JSON.stringify(event)}\n${doneStream('')}`] }],
      { resumeChatId: 'chat-1' },
      { ...claude, MAX_LAUNCHES: 1 },
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'chat-1'])('writes the hook files into the state directory for resume %s', async (resumeChatId) => {
    const { root } = await start('home', [{ chunks: [answered] }], { resumeChatId }, claude);
    const state = agentStateDir(root, 'run1', sessionHome('implement'));
    expect(existsSync(join(state, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(state, '.claude', 'deny-background.sh'))).toBe(true);
  });
});

function killedStream(chatId: string): string {
  const killed = { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'killed', summary: 'tests' };
  const talk = { type: 'assistant', message: { content: [{ type: 'text', text: "I'll report when it ends" }] } };
  return `${chatStream(chatId)}${JSON.stringify(talk)}\n${doneStream("I'll report when it ends")}${JSON.stringify(killed)}\n`;
}

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
  root: string;
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
    const runtime = env.AGENTS_IMPLEMENT
      ? parseAgentList('AGENTS_IMPLEMENT', env.AGENTS_IMPLEMENT)[0].runtime
      : 'cursor';
    const result = await runner.run(input(root, outputFile, { runtime, ...patch }));
    return { result, spawn, outputFile, root };
  } finally {
    clock?.mockRestore();
  }
}

/** The chat id in the session file of these specs, null when there is none. */
function storedChat(root: string): string | null {
  const file = join(root, 'data', 'run1-plan-session.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { chatId: string | null }).chatId : null;
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
  for (const runtime of ['cursor', 'claude', 'codex']) {
    writeFileSync(
      join(root, 'data', `price-cache-${runtime}.json`),
      `${JSON.stringify({
        fetchedAt: new Date().toISOString(),
        prices: { m: { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 } },
      })}\n`,
    );
  }
}
