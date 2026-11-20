import { DataSource } from 'typeorm';
import { runTitle } from '../contract/requirements-view';
import { LoopEventEntity, RunEntity, StepStatEntity } from './entities';
import { ServerStallEntity } from './server-stall.entities';
import { repositoryDatabase } from './repository.spec-helpers';
import { StatsRepository } from './stats.repository';

function run(key: string, createdAt: string): Partial<RunEntity> {
  return {
    key,
    status: 'done',
    currentStep: 'done',
    runtime: 'claude',
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
        stalls: [],
      });
    } finally {
      await db.close();
    }
  });

  it('reads the server stalls from the start of the range, all when there is none, also without runs', async () => {
    const db = await repositoryDatabase();
    try {
      const stall = (startedAt: string): Partial<ServerStallEntity> => ({
        startedAt,
        durationMs: 20_000,
        kind: 'host-paused',
        runningAgents: 0,
        runningChecks: 0,
        runningSetups: 0,
        cpuPercent: 0,
        memoryBytes: 0,
      });
      await db.app
        .get(DataSource)
        .getRepository(ServerStallEntity)
        .save([stall('2026-10-01T00:00:00.000Z'), stall('2026-11-05T00:00:00.000Z')]);
      const stats = db.app.get(StatsRepository);

      expect((await stats.rows('2026-11-01T00:00:00.000Z')).stalls).toEqual([
        { startedAt: '2026-11-05T00:00:00.000Z', durationMs: 20_000, kind: 'host-paused' },
      ]);
      expect((await stats.rows(null)).stalls).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  it('reads a prefix of a long prompt when it settles the name and title, else the whole prompt', async () => {
    const db = await repositoryDatabase();
    try {
      const filler = 'word '.repeat(2_000);
      const prompts = {
        enough: `\n  # Add a field\nmore text\n${filler}`,
        oneLine: `Add a field ${filler}`,
        marksFirst: `${'#\n'.repeat(3_000)}Add a field\nmore\n${filler}`,
        short: 'Add a field\nmore',
      };
      await db.app
        .get(DataSource)
        .getRepository(RunEntity)
        .save(Object.entries(prompts).map(([key, prompt]) => ({ ...run(key, '2026-11-05T00:00:00.000Z'), prompt })));

      const rows = await db.app.get(StatsRepository).rows(null);
      const byKey = new Map(rows.runs.map((row) => [row.key, row.prompt ?? '']));

      expect(byKey.get('short')).toBe(prompts.short);
      expect(byKey.get('oneLine')).toBe(prompts.oneLine);
      expect(byKey.get('marksFirst')).toBe(prompts.marksFirst);
      const enough = byKey.get('enough') ?? '';
      expect(enough.length).toBeLessThan(prompts.enough.length);
      expect(prompts.enough.startsWith(enough)).toBe(true);
      expect(runTitle(enough)).toBe(runTitle(prompts.enough));
      expect(enough.trim().split('\n')[0]).toBe(prompts.enough.trim().split('\n')[0]);
      expect(rows.runs.every((row) => !('promptLength' in row))).toBe(true);
    } finally {
      await db.close();
    }
  });
});
