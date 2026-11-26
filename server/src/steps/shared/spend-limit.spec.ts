import { AppConfig, type SwarmloopEnv } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import { AgentCallRepository } from '../../history/agent-call.repository';
import { seedCall } from '../../history/agent-call.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { save } from '../../testing/runs.spec-helpers';
import { SpendLimit } from './spend-limit';

async function withLimit(
  env: Partial<SwarmloopEnv>,
  test: (limit: SpendLimit, run: { id: number; key: string }, calls: AgentCallRepository) => Promise<void>,
): Promise<void> {
  const db = await repositoryDatabase();
  try {
    const runs = db.app.get(RunRepository);
    const calls = db.app.get(AgentCallRepository);
    const config = new AppConfig(testEnv({ SWARMLOOP_ROOT: db.root, ...env }));
    const run = await save(runs, 'proj-1', 'implement', 'running');
    await test(new SpendLimit(runs, db.app.get(DocumentRepository), calls, config), run, calls);
  } finally {
    await db.close();
  }
}

describe('SpendLimit.overLimit', () => {
  it('stops a run whose logged cost reaches MAX_RUN_USD', () =>
    withLimit({ MAX_RUN_USD: 2 }, async (limit, run, calls) => {
      await seedCall(calls, { runKey: run.key, usd: 1.5 });
      expect(await limit.overLimit(run)).toBeNull();
      await seedCall(calls, { runKey: run.key, usd: 0.5 });
      expect(await limit.overLimit(run)).toBe('spent $2.00 of MAX_RUN_USD $2.00; raise MAX_RUN_USD, then Resume');
    }));

  it('counts the pings of the run toward the limit', () =>
    withLimit({ MAX_RUN_USD: 2 }, async (limit, run, calls) => {
      await seedCall(calls, { runKey: run.key, usd: 1.5 });
      await seedCall(calls, { runKey: run.key, usd: 0.5, ping: true });
      expect(await limit.overLimit(run)).toContain('MAX_RUN_USD');
    }));

  it('stops a run whose logged tokens reach MAX_RUN_TOKENS, all four kinds counted', () =>
    withLimit({ MAX_RUN_TOKENS: 100 }, async (limit, run, calls) => {
      await seedCall(calls, { runKey: run.key, input: 10, cacheRead: 40, cacheWrite: 20, output: 20 });
      expect(await limit.overLimit(run)).toBeNull();
      await seedCall(calls, { runKey: run.key, cacheRead: 10, ping: true });
      expect(await limit.overLimit(run)).toBe(
        'used 100 tokens of MAX_RUN_TOKENS 100; raise MAX_RUN_TOKENS, then Resume',
      );
    }));

  it('reads only the rows of its own run', () =>
    withLimit({ MAX_RUN_USD: 2, MAX_RUN_TOKENS: 100 }, async (limit, run, calls) => {
      await seedCall(calls, { runKey: 'other-run', usd: 9, output: 999 });
      expect(await limit.overLimit(run)).toBeNull();
    }));

  it('gives null for a run that is not stored', () =>
    withLimit({ MAX_RUN_USD: 2 }, async (limit) => {
      expect(await limit.overLimit({ id: 9999 })).toBeNull();
    }));
});
