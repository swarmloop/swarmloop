import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AgentProcessRunner } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import type { StepEvent } from '../../contract/step-events';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { runInStepScope } from '../../core/step-event-scope';
import type { AgentRunResult } from '../../agent/agent-result';
import type { RunEntity } from '../../history/entities';
import { ChatUsageRepository } from '../../history/chat-usage.repository';
import { repositoryDatabase, repositoryVisit } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import type { SandboxService } from '../../sandbox/sandbox.service';
import { AgentLauncher } from './agent-launcher';
import { controlled, type Child, until } from './agent-launcher.spec-helpers';
import { AttemptChatUsage } from './attempt-chat-usage';
import { agentExchange } from './model-visit';

const CHAT = JSON.stringify({ session_id: 'chat-9' });

interface Reported {
  /** The session total the result line reports. */
  total: number;
  /** The visit's own part, when the line reports it apart from the total. */
  own?: number;
  /** The line ends a try that failed on the model host's API. */
  apiError?: boolean;
  /** The launch is another try of the visit before it: the same attempt, stored with it. */
  sameVisit?: boolean;
}

function resultLine({ total, own, apiError }: Reported): string {
  return JSON.stringify({
    type: 'result',
    session_id: 'chat-9',
    ...(apiError ? { is_error: true, terminal_reason: 'api_error' } : {}),
    total_cost_usd: total,
    usage: apiError
      ? { input_tokens: 0, output_tokens: 0 }
      : { input_tokens: Math.round(total * 1000), output_tokens: Math.round(total * 100) },
    ...(own === undefined
      ? {}
      : {
          model_usage_since_last_result: {
            m: { inputTokens: Math.round(own * 1000), outputTokens: Math.round(own * 100), costUSD: own },
          },
        }),
  });
}

/** Launches one visit after another into one chat, each its own attempt, and stores each as the step does. */
async function visitsOfOneChat(lines: Reported[]): Promise<{ usd: number[]; tokensIn: number[] }> {
  const db = await repositoryDatabase();
  try {
    mkdirSync(join(db.root, 'data'), { recursive: true });
    const price = { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0, cacheWritePerMillion: 0 };
    writeFileSync(
      join(db.root, 'data', 'price-cache-cursor.json'),
      JSON.stringify({ fetchedAt: new Date().toISOString(), prices: { m: price } }),
    );
    const clock = new FakeClock();
    const children: Child[] = [];
    const sandbox = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      spawn: jest.fn(() => {
        const child = controlled();
        children.push(child);
        return Promise.resolve(child);
      }),
      stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
      kill: jest.fn().mockResolvedValue(undefined),
    } as unknown as SandboxService;
    const config = new AppConfig(
      testEnv({ CURSOR_API_KEY: 'k', AGENTS_IMPLEMENT: 'cursor:m', SWARMLOOP_ROOT: db.root }),
    );
    const runner = new AgentProcessRunner(config, clock, sandbox, new RunStop());
    const visits = db.app.get(VisitRepository);
    const launcher = new AgentLauncher(
      runner,
      visits,
      new RunStop(),
      undefined,
      config,
      undefined,
      db.app.get(ChatUsageRepository),
      new AttemptChatUsage(),
    );
    const run = await db.app.get(RunRepository).openWaiting('run-1', '/target');
    const usd: number[] = [];
    const tokensIn: number[] = [];
    let attempt = -1;
    let stored: AgentRunResult[] = [];
    const store = async (): Promise<void> => {
      const last = stored[stored.length - 1];
      if (last) {
        await visits.finishVisit(run, {
          ...repositoryVisit(),
          usd: stored.reduce((sum, result) => sum + result.usd, 0),
          tokensIn: stored.reduce((sum, result) => sum + result.tokensIn, 0),
          tokensOut: stored.reduce((sum, result) => sum + result.tokensOut, 0),
          exchange: agentExchange(last, 'm', 'go'),
        });
      }
      stored = [];
    };
    for (const [index, line] of lines.entries()) {
      if (!line.sameVisit) {
        await store();
        attempt += 1;
      }
      const attemptId = `attempt-${attempt}`;
      Object.assign(run, { runtime: 'cursor', activeAttempt: attemptId } as Partial<RunEntity>);
      const scope = {
        runId: run.id,
        attemptId,
        step: 'implement' as const,
        root: db.root,
        clock,
        sink: (_event: StepEvent) => Promise.resolve(),
      };
      const running = runInStepScope(scope, 0, () =>
        launcher.launch({
          root: db.root,
          run,
          key: 'run1',
          step: 'implement',
          mode: 'agent',
          tools: 'write',
          runtime: 'cursor',
          model: 'm',
          timeLimitMs: 20_000,
          prompt: 'go',
          workspace: db.root,
          mounts: [{ hostPath: db.root, containerPath: '/work/demo' }],
        }),
      );
      await until(() => children.length === index + 1);
      children[index].stdout.write(`${CHAT}\n${resultLine(line)}\n`);
      const result = await running;
      usd.push(result.usd);
      tokensIn.push(result.tokensIn);
      stored.push(result);
    }
    await store();
    return { usd, tokensIn };
  } finally {
    await db.close();
  }
}

describe('the cost of a resumed chat', () => {
  it('takes a session whose totals restart at the first resume as its parts', async () => {
    const restart = await visitsOfOneChat([
      { total: 1.37 },
      { total: 0.1 },
      { total: 0.18 },
      { total: 0.26 },
      { total: 0.33 },
    ]);
    [1.37, 0.1, 0.08, 0.08, 0.07].forEach((part, index) => expect(restart.usd[index]).toBeCloseTo(part, 9));
    [1370, 100, 80, 80, 70].forEach((part, index) => expect(restart.tokensIn[index]).toBe(part));
    const steady = await visitsOfOneChat([{ total: 1 }, { total: 2.5 }, { total: 4 }]);
    [1, 1.5, 1.5].forEach((part, index) => expect(steady.usd[index]).toBeCloseTo(part, 9));
  });

  it('takes a session-total line against the reported total of a visit whose line reported its own part', async () => {
    const { usd } = await visitsOfOneChat([{ total: 1.37, own: 0.5 }, { total: 1.5 }]);
    expect(usd[0]).toBeCloseTo(0.5, 9);
    expect(usd[1]).toBeCloseTo(0.13, 9);
  });

  it('gives each try of a visit whose tries end with an API error only its own cost', async () => {
    const { usd, tokensIn } = await visitsOfOneChat([
      { total: 2 },
      { total: 1 },
      { total: 1.32 },
      { total: 1.32, apiError: true },
      { total: 1.32, apiError: true, sameVisit: true },
      { total: 1.32, apiError: true, sameVisit: true },
    ]);
    [2, 1, 0.32].forEach((part, index) => expect(usd[index]).toBeCloseTo(part, 9));
    expect(usd.slice(3)).toEqual([0, 0, 0]);
    expect(tokensIn.slice(3)).toEqual([0, 0, 0]);
  });
});
