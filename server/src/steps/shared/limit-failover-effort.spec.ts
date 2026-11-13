import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunStop } from '../../agent/run-stop';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { VisitDraft } from '../../history/visit';
import { AgentLauncher } from './agent-launcher';
import { LimitFailover } from './limit-failover';

const ran = { chatId: null, tokensIn: 0, tokensOut: 0, usd: 0, calls: 1, exitCode: 0, resumed: false, samples: [] };

function setup(env: Record<string, string>, epic: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-failover-effort-'));
  const run = {
    agentCalls: 0,
    spentUsd: 0,
    epicAt: epic ? '2026-01-01T00:00:00.000Z' : null,
    agents: {
      main: {
        implement: [
          { runtime: 'claude', model: 'm-claude', effort: 'high' },
          { runtime: 'codex', model: 'm-codex', effort: 'low' },
        ],
      },
    },
  } as never;
  const runner = {
    run: jest
      .fn()
      .mockResolvedValueOnce({ ...ran, responseText: 'limit', limit: { window: '5-hour' } })
      .mockResolvedValueOnce({ ...ran, responseText: 'done' }),
  };
  const finished: VisitDraft[] = [];
  const cooling: string[] = [];
  const failover = new LimitFailover(
    new AppConfig(testEnv(env)),
    new FakeClock(),
    {
      cooling: async () => new Set(cooling),
      set: async (runtime: string) => {
        cooling.push(runtime);
      },
      earliest: async () => ({ until: 0, resumeAt: 1 }),
    } as never,
    {
      finishVisit: async (_run: unknown, visit: VisitDraft) => {
        finished.push(visit);
      },
    } as never,
  );
  const launcher = new AgentLauncher(runner as never, { tokenTotal: async () => 0 } as never, new RunStop(), failover);
  const launch = () =>
    launcher.launch({
      root,
      run,
      key: 'run',
      step: 'implement',
      mode: 'agent',
      tools: 'write',
      runtime: 'claude',
      model: 'm-claude',
      effort: 'high',
      timeLimitMs: 1,
      prompt: 'prompt',
      workspace: root,
      mounts: [],
      failover: true,
    });
  return { runner, finished, launch };
}

describe('limit failover effort', () => {
  it('launches the next agent at its own effort and records the limited visit at the first agent effort', async () => {
    const { runner, finished, launch } = setup({ EPIC_EFFORT: '' }, false);
    const result = await launch();

    expect(runner.run.mock.calls[0][0]).toMatchObject({ runtime: 'claude', effort: 'high' });
    expect(runner.run.mock.calls[1][0]).toMatchObject({ runtime: 'codex', effort: 'low' });
    expect(finished[0]).toMatchObject({ runtime: 'claude', effort: 'high' });
    expect(result.agent).toEqual({ runtime: 'codex', model: 'm-codex', effort: 'low' });
  });

  it('raises the next agent of an epic parent to EPIC_EFFORT, held to what its runtime supports', async () => {
    const { runner, launch } = setup({ EPIC_EFFORT: 'max' }, true);
    const result = await launch();

    expect(runner.run.mock.calls[1][0]).toMatchObject({ runtime: 'codex', effort: 'xhigh' });
    expect(result.agent).toEqual({ runtime: 'codex', model: 'm-codex', effort: 'xhigh', effortNote: 'capped:max' });
  });
});
