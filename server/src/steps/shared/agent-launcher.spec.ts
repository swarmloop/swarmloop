import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentLaunch } from '../../agent/agent-launch';
import { AgentProcessRunner } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import type { Agent } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import type { StepEvent } from '../../contract/step-events';
import { SAMPLE_MS } from '../../core/awake-time';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { runInStepScope } from '../../core/step-event-scope';
import type { RunEntity } from '../../history/entities';
import type { VisitDraft } from '../../history/visit';
import type { VisitRepository } from '../../history/visit.repository';
import type { SandboxService } from '../../sandbox/sandbox.service';
import { AgentLauncher } from './agent-launcher';
import { controlled, type Child, until } from './agent-launcher.spec-helpers';
import { LimitFailover } from './limit-failover';

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
    let sampled!: () => void;
    const firstSample = new Promise<void>((resolve) => (sampled = resolve));
    const stats = jest.fn(async () => {
      sampled();
      return { cpuPercent: 0, rssBytes: 0 };
    });
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
    await firstSample;
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

describe('AgentLauncher host sleep', () => {
  async function launched() {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-sleep-'));
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
    const config = new AppConfig(testEnv({ CURSOR_API_KEY: 'k', AGENTS_IMPLEMENT: 'cursor:m', SWARMLOOP_ROOT: root }));
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
    return { children, running, events, clock };
  }

  it('stores no host suspension and does not kill a launch whose clock jumps 40 minutes between two samples', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const { children, running, events, clock } = await launched();
      await until(() => children.length === 1);
      children[0].stdout.write(`${CHAT}\n${THINKING}\n`);
      await until(() => events.some((event) => event.kind === 'agent.launched'));
      clock.advance(SAMPLE_MS);
      jest.advanceTimersByTime(SAMPLE_MS);
      clock.advance(40 * 60_000);
      jest.advanceTimersByTime(SAMPLE_MS);
      children[0].stdout.write(`${THINKING}\n${JSON.stringify({ type: 'result', result: 'done' })}\n`);
      children[0].exit(0);
      const result = await running;

      expect(events.some((event) => event.kind === ('host.suspended' as string))).toBe(false);
      expect(result.killReason).toBeNull();
      expect(events.find((event) => event.kind === 'agent.finished')).toMatchObject({ killReason: null });
      expect(children).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
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

describe('AgentLauncher for an owner that is not a run', () => {
  const ran = { chatId: null, tokensIn: 3, tokensOut: 4, usd: 0.5, calls: 1, exitCode: 0, resumed: false, samples: [] };
  const limited = { ...ran, responseText: 'limit', limit: { window: '5-hour' } };

  function setup(answers: object[], cooling: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-launcher-owner-'));
    const run = jest.fn();
    for (const answer of answers) run.mockResolvedValueOnce(answer);
    const recorded: VisitDraft[] = [];
    const finishVisit = jest.fn();
    const failover = new LimitFailover(
      new AppConfig(testEnv()),
      new FakeClock(),
      {
        cooling: async () => new Set(cooling),
        set: async (key: { runtime: string }) => {
          cooling.push(key.runtime);
        },
        earliest: async () => ({ until: 0, resumeAt: Date.UTC(2026, 0, 1, 1) }),
      } as never,
      { finishVisit } as never,
    );
    const tokenTotal = jest.fn(async () => 999);
    const launcher = new AgentLauncher({ run } as never, { tokenTotal } as never, new RunStop(), failover);
    const owner = {
      id: 7,
      agentCalls: 0,
      spentUsd: 1,
      activeAttempt: null,
      tokensSoFar: 12,
      roleAgents: [
        { runtime: 'claude', model: 'm-claude' },
        { runtime: 'codex', model: 'm-codex' },
      ] as Agent[],
      recordLimit: async (visit: VisitDraft) => {
        recorded.push(visit);
      },
    };
    const launch = () =>
      launcher.launch({
        root,
        run: owner,
        login: 'ada',
        key: 'turn-1',
        step: 'backlog-plan',
        mode: 'plan',
        tools: 'plan',
        runtime: 'claude',
        model: 'm-claude',
        timeLimitMs: 1,
        prompt: 'plan the backlog',
        workspace: root,
        mounts: [],
        failover: true,
      });
    return { run, launch, recorded, finishVisit, tokenTotal, owner };
  }

  it('launches with the login and the owner spend, and counts the calls on the owner', async () => {
    const { run, launch, tokenTotal, owner } = setup([{ ...ran, responseText: 'done' }]);
    await launch();
    expect(run.mock.calls[0][0]).toMatchObject({ login: 'ada', tokensInRun: 12, spentUsd: 1, attemptId: '' });
    expect(tokenTotal).not.toHaveBeenCalled();
    expect(owner).toMatchObject({ agentCalls: 1, spentUsd: 1.5 });
  });

  it('moves to the next agent of its own list on a limit and records the limited visit through the owner', async () => {
    const { run, launch, recorded, finishVisit } = setup([limited, { ...ran, responseText: 'done' }]);
    const result = await launch();
    expect(run.mock.calls.map((call) => call[0].runtime)).toEqual(['claude', 'codex']);
    expect(result.agent).toEqual({ runtime: 'codex', model: 'm-codex' });
    expect(recorded).toEqual([expect.objectContaining({ runtime: 'claude', status: 'interrupted' })]);
    expect(finishVisit).not.toHaveBeenCalled();
  });

  it('throws the usage limit with the time of the next try when every agent of its list is limited', async () => {
    const { run, launch, recorded } = setup([limited, limited]);
    await expect(launch()).rejects.toMatchObject({
      name: 'RuntimeLimit',
      resumesAt: new Date(Date.UTC(2026, 0, 1, 1)).toISOString(),
    });
    expect(run.mock.calls.map((call) => call[0].runtime)).toEqual(['claude', 'codex']);
    expect(recorded).toHaveLength(2);
  });
});

describe('AgentLaunch credential of a launch', () => {
  function launchWith(login?: string | null) {
    const runtimeCredential = jest.fn(async (_runtime: string, who: string | null) => ({
      name: 'KEY',
      value: 'secret',
      owner: who,
    }));
    const findRun = jest.fn(async () => ({ startedBy: 'grace', parentRunId: null }));
    const launch = new AgentLaunch(
      new AppConfig(testEnv()),
      new FakeClock(),
      {} as never,
      new RunStop(),
      {} as never,
      {} as never,
      {} as never,
      undefined,
      { runtimeCredential } as never,
      { findRun } as never,
    );
    return { found: launch.credentialOf('run-1', 'claude', login), runtimeCredential, findRun };
  }

  it('uses the credential of the given login without looking up a run', async () => {
    const { found, runtimeCredential, findRun } = launchWith('ada');
    expect(await found).toMatchObject({ owner: 'ada' });
    expect(runtimeCredential).toHaveBeenCalledWith('claude', 'ada');
    expect(findRun).not.toHaveBeenCalled();
  });

  it('resolves the starter of the run without a login, as before', async () => {
    const { found, runtimeCredential } = launchWith();
    expect(await found).toMatchObject({ owner: 'grace' });
    expect(runtimeCredential).toHaveBeenCalledWith('claude', 'grace');
  });
});

describe('AgentLauncher log folder', () => {
  async function promptSent(prompt: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-launcher-logs-'));
    const sent: string[] = [];
    const runner = {
      run: (options: { prompt: string }) => {
        sent.push(options.prompt);
        return Promise.resolve({
          chatId: null,
          resumed: false,
          killReason: null,
          tokensIn: 0,
          tokensOut: 0,
          usd: 0,
          calls: 1,
        });
      },
    } as unknown as AgentProcessRunner;
    const visits = { tokenTotal: () => Promise.resolve(0) } as unknown as VisitRepository;
    const launcher = new AgentLauncher(runner, visits, new RunStop());
    const run = { id: 1, runtime: 'cursor', agentCalls: 0, spentUsd: 0, activeAttempt: 'attempt-1' } as RunEntity;
    await launcher.launch({
      root,
      run,
      key: 'run1',
      step: 'implement',
      mode: 'agent',
      tools: 'write',
      runtime: 'cursor',
      model: 'm',
      timeLimitMs: 20_000,
      prompt,
      workspace: root,
      mounts: [{ hostPath: root, containerPath: '/work/demo' }],
    });
    return sent[0];
  }

  it('allows the log folder in a prompt that names a cut log, and in no other prompt', async () => {
    const block = 'The only working directory is /work/demo (demo). It has no source files.';
    const stay = 'Do not look outside it. Do not open .git.';
    const cut = await promptSent(
      [block, stay, '', 'Check output cut. The whole log is /work/logs/checks-log.txt.'].join('\n'),
    );
    expect(cut).toContain(
      `${block}\nAlso read, and nothing else outside: /work/logs/ (the full logs of cut check and pipeline output).\n${stay}`,
    );
    const plain = await promptSent([block, stay, '', 'Nothing was cut.'].join('\n'));
    expect(plain).not.toContain('Also read');
  });
});
