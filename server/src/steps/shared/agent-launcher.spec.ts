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
import type { VisitRepository } from '../../history/visit.repository';
import type { SandboxService } from '../../sandbox/sandbox.service';
import { AgentLauncher } from './agent-launcher';

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
      testEnv({ CURSOR_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', MODEL_IMPLEMENT: 'm', SWARMLOOP_ROOT: root }),
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
