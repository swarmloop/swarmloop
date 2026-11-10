import { DataSource } from 'typeorm';
import { LoopEventEntity, RunEntity, StepStatEntity } from './entities';
import { repositoryDatabase } from './repository.spec-helpers';
import { StatsRepository } from './stats.repository';

function run(key: string, createdAt: string): Partial<RunEntity> {
  return {
    key,
    status: 'done',
    currentStep: 'done',
    runtime: 'claude',
    requirementsVia: 'agent',
    issueTracker: 'jira',
    codeHost: '',
    createdAt,
    updatedAt: createdAt,
  };
}

describe('StatsRepository', () => {
  it('reads the runs from a time on, with their steps and returns, and when the first run started', async () => {
    const db = await repositoryDatabase();
    try {
      const data = db.app.get(DataSource);
      const [old, recent] = await data
        .getRepository(RunEntity)
        .save([run('old', '2026-10-01T00:00:00.000Z'), run('recent', '2026-11-05T00:00:00.000Z')]);
      const stat = (runId: number, usd: number): Partial<StepStatEntity> => ({
        runId,
        step: 'implement',
        attempt: 1,
        model: 'm',
        startedAt: '2026-11-05T00:00:00.000Z',
        finishedAt: '2026-11-05T00:01:00.000Z',
        durationMs: 60_000,
        status: 'done',
        usd,
      });
      await data.getRepository(StepStatEntity).save([stat(old.id, 1), stat(recent.id, 2)]);
      await data.getRepository(LoopEventEntity).save([
        {
          runId: old.id,
          counter: 'review',
          attempt: 1,
          reason: 'review_quality',
          createdAt: '2026-10-01T01:00:00.000Z',
        },
        { runId: recent.id, counter: 'pipeline', attempt: 1, reason: 'ci', createdAt: '2026-11-05T01:00:00.000Z' },
      ]);
      const stats = db.app.get(StatsRepository);

      const since = await stats.rows('2026-11-01T00:00:00.000Z');
      expect(since.firstRunAt).toBe('2026-10-01T00:00:00.000Z');
      expect(since.runs.map((row) => row.key)).toEqual(['recent']);
      expect(since.steps.map((row) => row.usd)).toEqual([2]);
      expect(since.loops.map((row) => row.counter)).toEqual(['pipeline']);

      const all = await stats.rows(null);
      expect(all.runs.map((row) => row.key)).toEqual(['old', 'recent']);
      expect(all.steps).toHaveLength(2);
      expect(all.loops).toHaveLength(2);
      expect(await stats.rows('2027-01-01T00:00:00.000Z')).toEqual({
        firstRunAt: '2026-10-01T00:00:00.000Z',
        runs: [],
        steps: [],
        loops: [],
      });
    } finally {
      await db.close();
    }
  });
});
