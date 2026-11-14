import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { AgentProcessRunner } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import type { StepEvent } from '../../contract/step-events';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { runInStepScope } from '../../core/step-event-scope';
import type { RunEntity } from '../../history/entities';
import { sessionFileName } from '../../history/session-group';
import type { VisitRepository } from '../../history/visit.repository';
import type { SandboxService } from '../../sandbox/sandbox.service';
import { AgentLauncher } from './agent-launcher';
import { LimitFailover } from './limit-failover';
import { SwarmloopError } from '../../core/swarmloop-error';

const CHAT = JSON.stringify({ session_id: 'chat-9' });
const THINKING = JSON.stringify({ type: 'thinking', text: 'working' });

function toolStarted(command: string): string {
  return JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: { shellToolCall: { args: { command } } },
  });
}

function toolCompleted(): string {
  return JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    tool_call: { shellToolCall: { result: { success: {} } } },
  });
}

/** A child that stays up until a spec ends it, or until the runner kills it. */
function controlled() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const exit = (code: number): void => {
    child.emit('close', code);
  };
  const kill = jest.fn(() => {
    setImmediate(() => exit(1));
    return true;
  });
  return Object.assign(child, { stdout, stderr: new PassThrough(), containerName: 'box', kill, exit });
}

type Child = ReturnType<typeof controlled>;

async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100_000 && !done(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(done()).toBe(true);
}

describe('AgentLauncher relaunch', () => {
  const FIRST_COMMAND = 'sleep 100';
  const SECOND_COMMAND = 'npm test';

  /** Runs a launcher over two children. `first` leaves the first launch mid-tool and ends it. */
  async function relaunch(first: (child: Child, clock: FakeClock) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-launcher-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    for (const runtime of ['cursor', 'claude']) {
      const price = { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 };
      writeFileSync(
        join(root, 'data', `price-cache-${runtime}.json`),
        JSON.stringify({ fetchedAt: new Date().toISOString(), prices: { m: price } }),
      );
    }
    const clock = new FakeClock();
    const children: Child[] = [];
    const spawn = jest.fn(() => {
      const child = controlled();
      children.push(child);
      return Promise.resolve(child);
    });
    const stats = jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 });
    const sandbox = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      spawn,
      stats,
      kill: jest.fn().mockResolvedValue(undefined),
    } as unknown as SandboxService;
    const config = new AppConfig(
      testEnv({ CURSOR_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', AGENTS_IMPLEMENT: 'cursor:m', SWARMLOOP_ROOT: root }),
    );
    const runner = new AgentProcessRunner(config, clock, sandbox, new RunStop());
    const visits = { tokenTotal: () => Promise.resolve(0) } as unknown as VisitRepository;
    const launcher = new AgentLauncher(runner, visits, new RunStop());
    const run = { id: 1, runtime: 'cursor', agentCalls: 0, spentUsd: 0, activeAttempt: 'attempt-1' } as RunEntity;
    const events: StepEvent[] = [];
    const scope = {
      runId: 1,
      attemptId: 'attempt-1',
      step: 'implement' as const,
      root,
      clock,
      sink: (event: StepEvent) => {
        events.push(event);
        return Promise.resolve();
      },
    };
    const tools = (): string[] => events.flatMap((event) => (event.kind === 'agent.tool' ? [event.target] : []));
    const running = runInStepScope(scope, 0, () =>
      launcher.launch({
        root,
        run,
        key: 'run1',
        step: 'implement',
        mode: 'agent',
        tools: 'write',
        runtime: 'cursor',
        model: 'm',
        timeLimitMs: 20_000,
        prompt: 'go',
        workspace: root,
        mounts: [{ hostPath: root, containerPath: '/work/demo' }],
      }),
    );
    await until(() => children.length === 1);
    // The first sample comes when the runner reads the stream live, so the chunks below are not replayed in one go.
    await until(() => stats.mock.calls.length === 1);
    children[0].stdout.write(`${CHAT}\n${toolStarted(FIRST_COMMAND)}\n`);
    await first(children[0], clock);
    await until(() => children.length === 2);
    clock.advance(1_000);
    children[1].stdout.write(`${toolStarted(SECOND_COMMAND)}\n${toolCompleted()}\n`);
    // The second launch is still running: its tool must already be in the log.
    await until(() => tools().includes(SECOND_COMMAND));
    const live = events.find((event) => event.kind === 'agent.tool' && event.target === SECOND_COMMAND);
    children[1].stdout.write(`${JSON.stringify({ type: 'result', result: 'done' })}\n`);
    children[1].exit(0);
    await running;
    return { live, tools: tools(), clock };
  }

  it('records the tool calls of a launch relaunched after a time kill while it runs', async () => {
    const { live, tools, clock } = await relaunch(async (child, clock) => {
      // Awake samples, each shorter than a suspension, until the 20 s limit is used.
      for (let second = 0; second < 2; second += 1) {
        clock.advance(10_000);
        child.stdout.write(`${THINKING}\n`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    expect(tools).toEqual([FIRST_COMMAND, SECOND_COMMAND]);
    expect(live?.occurredAt).toBe(clock.iso());
  });

  it('records the tool calls of a launch relaunched after a crash while it runs', async () => {
    const { live, tools, clock } = await relaunch((child) => {
      child.exit(1);
      return Promise.resolve();
    });
    expect(tools).toEqual([FIRST_COMMAND, SECOND_COMMAND]);
    expect(live?.occurredAt).toBe(clock.iso());
  });
});

function failedShell(command: string, stdout: string): string {
  return [
    toolStarted(command),
    JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: { shellToolCall: { result: { success: { exitCode: 1, stdout } } } },
    }),
  ].join('\n');
}

describe('AgentLauncher loop', () => {
  async function loop() {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-loop-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    const price = { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 };
    writeFileSync(
      join(root, 'data', 'price-cache-cursor.json'),
      JSON.stringify({ fetchedAt: new Date().toISOString(), prices: { m: price } }),
    );
    const clock = new FakeClock();
    const children: Child[] = [];
    const spawn = jest.fn(() => {
      const child = controlled();
      children.push(child);
      return Promise.resolve(child);
    });
    const sandbox = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      spawn,
      stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
      kill: jest.fn().mockResolvedValue(undefined),
    } as unknown as SandboxService;
    const config = new AppConfig(
      testEnv({ CURSOR_API_KEY: 'k', AGENTS_IMPLEMENT: 'cursor:m', SWARMLOOP_ROOT: root, LOOP_REPEAT: 2 }),
    );
    const runner = new AgentProcessRunner(config, clock, sandbox, new RunStop());
    const visits = { tokenTotal: () => Promise.resolve(0) } as unknown as VisitRepository;
    const launcher = new AgentLauncher(runner, visits, new RunStop(), undefined, config);
    const run = { id: 1, runtime: 'cursor', agentCalls: 0, spentUsd: 0, activeAttempt: 'attempt-1' } as RunEntity;
    const events: StepEvent[] = [];
    const scope = {
      runId: 1,
      attemptId: 'attempt-1',
      step: 'implement' as const,
      root,
      clock,
      sink: (event: StepEvent) => {
        events.push(event);
        return Promise.resolve();
      },
    };
    const running = runInStepScope(scope, 0, () =>
      launcher.launch({
        root,
        run,
        key: 'run1',
        step: 'implement',
        mode: 'agent',
        tools: 'write',
        runtime: 'cursor',
        model: 'm',
        timeLimitMs: 20_000,
        prompt: 'go',
        workspace: root,
        mounts: [{ hostPath: root, containerPath: '/work/demo' }],
      }),
    );
    const hints = (): StepEvent[] => events.filter((event) => event.kind === 'agent.loop_hint');
    return { children, spawn, running, hints, events };
  }

  it('hints once into the same chat, then ends the step when the agent keeps repeating the command', async () => {
    const { children, spawn, running, hints, events } = await loop();
    await until(() => children.length === 1);
    const failing = failedShell('npm test 2>&1 | tail -n 5', 'Cannot find module x\nmore');
    children[0].stdout.write(`${CHAT}\n${failing}\n${failing}\n`);

    await until(() => children.length === 2);
    expect(hints()).toMatchObject([{ command: 'npm test', errorLine: 'Cannot find module x', count: 2 }]);
    expect(JSON.stringify(spawn.mock.calls[1])).toContain('chat-9');

    children[1].stdout.write(`${failing}\n${failing}\n`);
    const result = await running;

    expect(result.killReason).toBe('loop');
    expect(children).toHaveLength(2);
    expect(hints().map((event) => event.kind === 'agent.loop_hint' && event.ended)).toEqual([undefined, true]);
    expect(hints()[1]).toMatchObject({ command: 'npm test', count: 4 });
    expect(events.some((event) => event.kind === 'agent.finished' && event.killReason === 'loop')).toBe(true);
  });
});

describe('AgentLauncher parse retry', () => {
  it('preserves a killed-background-work result instead of retrying its parse failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-background-killed-'));
    const runner = {
      run: jest.fn().mockResolvedValue({
        responseText: 'summary:\n- done\n',
        chatId: 'chat-1',
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        killReason: null,
        backgroundKilled: true,
        exitCode: 0,
        resumed: false,
        calls: 1,
        samples: [],
        durationMs: 0,
        startedAt: '',
        finishedAt: '',
      }),
    };
    const result = await new AgentLauncher(
      runner as never,
      { tokenTotal: async () => 0 } as never,
      new RunStop(),
    ).launch({
      root,
      run: { agentCalls: 0, spentUsd: 0 } as never,
      key: 'run',
      step: 'implement',
      mode: 'agent',
      tools: 'write',
      runtime: 'cursor',
      model: 'm',
      timeLimitMs: 1,
      prompt: 'implement',
      workspace: root,
      mounts: [],
      validate: () => {
        throw new SwarmloopError('implementation is missing');
      },
      parseFailureEnding: 'implementation:\n- item',
    });

    expect(result.backgroundKilled).toBe(true);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('continues the same chat with the missing section instead of the full prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-parse-retry-'));
    const prompts: string[] = [];
    const freshPrompts: (string | undefined)[] = [];
    const chatIds: (string | null)[] = [];
    const runner = {
      run: jest.fn(async (input) => {
        prompts.push(input.prompt);
        freshPrompts.push(input.freshPrompt);
        chatIds.push(input.resumeChatId);
        if (prompts.length === 1) {
          mkdirSync(join(root, 'data', 'agent-state', 'run', 'implement'), { recursive: true });
          writeFileSync(input.sessionFile, JSON.stringify({ runtime: 'cursor', chatId: 'chat-1', usd: 0 }));
        }
        return {
          responseText: prompts.length === 1 ? 'summary:\n- done\n' : 'implementation:\n- fixed\n\nsummary:\n- done\n',
          chatId: 'chat-1',
          tokensIn: 0,
          tokensOut: 0,
          usd: 0,
          killReason: null,
          exitCode: 0,
          resumed: prompts.length > 1,
          calls: 1,
          samples: [],
          durationMs: 0,
          startedAt: '',
          finishedAt: '',
        };
      }),
    };
    const result = await new AgentLauncher(
      runner as never,
      { tokenTotal: async () => 0 } as never,
      new RunStop(),
    ).launch({
      root,
      run: { runtime: 'cursor', agentCalls: 0, spentUsd: 0 } as never,
      key: 'run',
      step: 'implement',
      mode: 'agent',
      tools: 'write',
      runtime: 'cursor',
      model: 'm',
      timeLimitMs: 1,
      prompt: 'a resumed implementation follow-up',
      freshPrompt: 'the full implementation prompt',
      workspace: root,
      mounts: [],
      validate: (text) => {
        if (!text.includes('implementation:')) throw new SwarmloopError('implementation is missing');
      },
      parseFailureEnding: 'implementation:\n- item\n\nsummary:\n- why',
    });

    expect(result.responseText).toContain('implementation:');
    expect(prompts[1]).toContain('missing the implementation section');
    expect(prompts[1]).toContain('implementation:\n- item\n\nsummary:\n- why');
    expect(prompts[1]).not.toContain('the full implementation prompt');
    expect(freshPrompts[1]).toContain('the full implementation prompt');
    expect(chatIds[1]).toBe('chat-1');
  });
});

describe('AgentLauncher runtime of the agent', () => {
  it('starts a new chat with the full brief when the stored chat belongs to another runtime than the step agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-agent-runtime-'));
    mkdirSync(join(root, 'data', 'agent-state', 'run', 'review'), { recursive: true });
    const file = join(root, 'data', sessionFileName('run', 'review'));
    writeFileSync(file, JSON.stringify({ runtime: 'cursor', chatId: 'chat-1', usd: 0 }));
    const runner = {
      run: jest.fn().mockResolvedValue({
        responseText: 'ok',
        chatId: 'chat-2',
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        killReason: null,
        exitCode: 0,
        resumed: false,
        calls: 1,
        samples: [],
        durationMs: 0,
        startedAt: '',
        finishedAt: '',
      }),
    };
    const events: StepEvent[] = [];
    const scope = {
      runId: 1,
      attemptId: 'attempt-1',
      step: 'implement' as const,
      root,
      clock: new FakeClock(),
      sink: (event: StepEvent) => {
        events.push(event);
        return Promise.resolve();
      },
    };
    const launcher = new AgentLauncher(runner as never, { tokenTotal: async () => 0 } as never, new RunStop());
    const launch = (runtime: 'cursor' | 'claude') =>
      runInStepScope(scope, 0, () =>
        launcher.launch({
          root,
          run: { runtime: 'cursor', agentCalls: 0, spentUsd: 0 } as never,
          key: 'run',
          step: 'review',
          mode: 'ask',
          tools: 'write',
          runtime,
          model: 'm',
          timeLimitMs: 1,
          prompt: 'follow up',
          freshPrompt: 'the full brief',
          workspace: root,
          mounts: [],
        }),
      );

    await launch('claude');
    expect(runner.run.mock.calls[0][0]).toMatchObject({ runtime: 'claude', resumeChatId: null });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'session.changed', runtime: 'claude', reason: 'runtime changed' }),
    );

    await launch('cursor');
    expect(runner.run.mock.calls[1][0]).toMatchObject({ runtime: 'cursor', resumeChatId: 'chat-1' });
  });
  it('mounts the CLI of the agent that took over after a limit, and never a second launch on the old one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-launcher-failover-'));
    const ran = { chatId: null, tokensIn: 0, tokensOut: 0, usd: 0, calls: 1, exitCode: 0, resumed: false, samples: [] };
    const runner = {
      run: jest
        .fn()
        .mockResolvedValueOnce({ ...ran, responseText: 'limit', limit: { window: '5-hour' } })
        .mockResolvedValueOnce({ ...ran, responseText: 'done' }),
    };
    const failover = {
      start: (request: object) => Promise.resolve(request),
      limited: (request: object) =>
        Promise.resolve({ ...request, runtime: 'codex', model: 'm-codex', resume: false, prompt: 'the full brief' }),
    };
    const projectFor = jest.fn((runtime: string) => Promise.resolve({ cliVolume: `cli-${runtime}` }));
    const launcher = new AgentLauncher(
      runner as never,
      { tokenTotal: async () => 0 } as never,
      new RunStop(),
      failover as never,
    );
    const result = await launcher.launch({
      root,
      run: { agentCalls: 0, spentUsd: 0 } as never,
      key: 'run',
      step: 'implement',
      mode: 'agent',
      tools: 'write',
      runtime: 'claude',
      model: 'm-claude',
      timeLimitMs: 1,
      prompt: 'follow up',
      workspace: root,
      mounts: [],
      failover: true,
      project: { cliVolume: 'cli-claude' } as never,
      projectFor: projectFor as never,
    });

    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.run.mock.calls[0][0]).toMatchObject({ runtime: 'claude', project: { cliVolume: 'cli-claude' } });
    expect(runner.run.mock.calls[1][0]).toMatchObject({
      runtime: 'codex',
      prompt: expect.stringContaining('the full brief'),
      project: { cliVolume: 'cli-codex' },
    });
    expect(result.agent).toEqual({ runtime: 'codex', model: 'm-codex' });
  });

  describe('with the real failover', () => {
    const ran = { chatId: null, tokensIn: 0, tokensOut: 0, usd: 0, calls: 1, exitCode: 0, resumed: false, samples: [] };

    function setup(cooling: string[], limited = cooling.length === 0) {
      const root = mkdtempSync(join(tmpdir(), 'swarmloop-launcher-briefs-'));
      const runEntity = {
        agentCalls: 0,
        spentUsd: 0,
        agents: {
          main: {
            implement: [
              { runtime: 'claude', model: 'm-claude' },
              { runtime: 'codex', model: 'm-codex' },
            ],
          },
        },
      } as never;
      const run = jest.fn().mockResolvedValue({ ...ran, responseText: 'done' });
      if (limited) {
        run.mockResolvedValueOnce({ ...ran, responseText: 'limit', limit: { window: '5-hour' } });
      }
      const runner = { run };
      const failover = new LimitFailover(
        new AppConfig(testEnv()),
        new FakeClock(),
        {
          cooling: async () => new Set(cooling),
          set: async (key: { runtime: string }) => {
            cooling.push(key.runtime);
          },
          earliest: async () => ({ until: 0, resumeAt: 1 }),
        } as never,
        { finishVisit: async () => undefined } as never,
      );
      const launcher = new AgentLauncher(
        runner as never,
        { tokenTotal: async () => 0 } as never,
        new RunStop(),
        failover,
      );
      const launch = (extra: object) =>
        launcher.launch({
          root,
          run: runEntity,
          key: 'run',
          step: 'implement',
          mode: 'agent',
          tools: 'write',
          runtime: 'claude',
          model: 'm-claude',
          timeLimitMs: 1,
          prompt: 'prompt for claude',
          workspace: root,
          mounts: [],
          failover: true,
          ...extra,
        });
      return { runner, launch };
    }

    it('sends the brief of the new runtime after a limit', async () => {
      const { runner, launch } = setup([]);
      await launch({ brief: 'old brief', briefFor: (runtime: string) => `brief for ${runtime}` });
      expect(runner.run.mock.calls[1][0].prompt).toContain('brief for codex');
    });

    it('sends the brief of the new runtime when a launch starts on another runtime', async () => {
      const { runner, launch } = setup(['claude']);
      await launch({ briefFor: (runtime: string) => `brief for ${runtime}` });
      expect(runner.run.mock.calls[0][0]).toMatchObject({ runtime: 'codex' });
      expect(runner.run.mock.calls[0][0].prompt).toContain('brief for codex');
    });

    it('falls back to the brief or the prompt without briefFor', async () => {
      const limited = setup([]);
      await limited.launch({ brief: 'old brief' });
      expect(limited.runner.run.mock.calls[1][0].prompt).toContain('old brief');
      const started = setup(['claude']);
      await started.launch({});
      expect(started.runner.run.mock.calls[0][0].prompt).toContain('prompt for claude');
    });
  });
});

describe('AgentLauncher effort', () => {
  async function launched(extra: object) {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-launcher-effort-'));
    const runner = {
      run: jest.fn().mockResolvedValue({
        responseText: 'ok',
        chatId: null,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        killReason: null,
        exitCode: 0,
        resumed: false,
        calls: 1,
        samples: [],
        durationMs: 0,
        startedAt: '',
        finishedAt: '',
      }),
    };
    const events: StepEvent[] = [];
    const scope = {
      runId: 1,
      attemptId: 'attempt-1',
      step: 'implement' as const,
      root,
      clock: new FakeClock(),
      sink: (event: StepEvent) => {
        events.push(event);
        return Promise.resolve();
      },
    };
    const launcher = new AgentLauncher(runner as never, { tokenTotal: async () => 0 } as never, new RunStop());
    await runInStepScope(scope, 0, () =>
      launcher.launch({
        root,
        run: { agentCalls: 0, spentUsd: 0 } as never,
        key: 'run',
        step: 'implement',
        mode: 'agent',
        tools: 'write',
        runtime: 'codex',
        model: 'm-codex',
        timeLimitMs: 1,
        prompt: 'prompt',
        workspace: root,
        mounts: [],
        ...extra,
      }),
    );
    return { input: runner.run.mock.calls[0][0], events };
  }

  it('runs a capped agent at the level it got and says what was wanted', async () => {
    const { input, events } = await launched({ effort: 'xhigh', effortNote: 'capped:max' });

    expect(input.effort).toBe('xhigh');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'agent.effort_capped',
        text: 'm-codex supports up to xhigh; ran at xhigh instead of max.',
      }),
    );
  });

  it('launches an agent without an effort with no effort in the input and no event', async () => {
    const { input, events } = await launched({});

    expect('effort' in input).toBe(false);
    expect(events.some((event) => event.kind === 'agent.effort_capped')).toBe(false);
  });

  it('records no cap event for an effort an epic raised', async () => {
    const { input, events } = await launched({ effort: 'xhigh', effortNote: 'epic' });

    expect(input.effort).toBe('xhigh');
    expect(events.some((event) => event.kind === 'agent.effort_capped')).toBe(false);
  });
});
