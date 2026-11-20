import { DataSource } from 'typeorm';
import { EtaHistoryRepository } from './eta-history.repository';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunEntity } from './run.entity';
import { RunRepository } from './run.repository';
import { RunWaitEntity } from './run-wait.entity';
import { StepStatEntity } from './step-stat.entity';

const MERGED = JSON.stringify({ merged: { app: { sha: 'a', by: null, at: '2026-01-01T03:00:00.000Z', url: null } } });
const CLOSED = JSON.stringify({ closed: { repo: 'app', by: null, at: '2026-01-01T03:00:00.000Z' } });

describe('EtaHistoryRepository', () => {
  it('reads the newest finished runs of each kind with their visits, waits and merge time', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const source = db.app.get(DataSource);
      const patch = (key: string, set: Partial<RunEntity>) => source.getRepository(RunEntity).update({ key }, set);
      const plain = ['old', 'mid', 'new'];
      for (const [index, key] of plain.entries()) {
        await runs.openWaiting(key, '/t');
        await patch(key, { status: 'done', createdAt: `2026-01-01T0${index}:00:00.000Z` });
      }
      const closed = await runs.openWaiting('closed', '/t');
      await patch(closed.key, { status: 'done', mergeOutcome: CLOSED });
      const parent = await runs.openWaiting('parent', '/t');
      await patch(parent.key, { status: 'running', epicAt: '2026-01-01T00:00:00.000Z' });
      const merged = await runs.openWaiting('merged', '/t');
      await patch(merged.key, { status: 'done', parentRunId: parent.id, mergeOutcome: MERGED });
      const unmerged = await runs.openWaiting('unmerged', '/t');
      await patch(unmerged.key, { status: 'done', parentRunId: parent.id });
      const newest = (await runs.findRun('new'))!;
      const stat = (step: string, stepStartedAt: string | null, finishedAt: string) =>
        source.getRepository(StepStatEntity).insert({
          runId: newest.id,
          step,
          attempt: 1,
          startedAt: '2026-01-01T02:00:00.000Z',
          stepStartedAt,
          finishedAt,
          durationMs: 1,
          status: 'done',
        });
      await stat('implement', '2026-01-01T02:10:00.000Z', '2026-01-01T02:20:00.000Z');
      await stat('implement', '2026-01-01T02:10:00.000Z', '2026-01-01T02:30:00.000Z');
      await stat('research', null, '2026-01-01T02:05:00.000Z');
      await source.getRepository(RunWaitEntity).insert({
        runId: newest.id,
        kind: 'person',
        code: 'NEEDS_ANSWERS',
        startedAt: '2026-01-01T02:11:00.000Z',
        endedAt: '2026-01-01T02:12:00.000Z',
      });

      const found = await db.app.get(EtaHistoryRepository).finishedRuns(2);
      const plainRuns = found.filter((run) => run.kind === 'plain');
      expect(plainRuns.map((run) => run.id)).toEqual(
        [newest.id, (await runs.findRun('mid'))!.id].sort((a, b) => b - a),
      );
      expect(found.filter((run) => run.kind === 'subtask').map((run) => run.id)).toEqual([merged.id]);
      expect(found.filter((run) => run.kind === 'epic')).toEqual([]);
      expect(found.find((run) => run.id === merged.id)?.mergedAt).toBe('2026-01-01T03:00:00.000Z');
      const full = found.find((run) => run.id === newest.id)!;
      expect(full.steps).toEqual([
        { step: 'implement', enteredAt: '2026-01-01T02:10:00.000Z', lastFinishedAt: '2026-01-01T02:30:00.000Z' },
        { step: 'research', enteredAt: '2026-01-01T02:00:00.000Z', lastFinishedAt: '2026-01-01T02:05:00.000Z' },
      ]);
      expect(full.waits).toMatchObject([{ kind: 'person', code: 'NEEDS_ANSWERS' }]);
      expect(found.some((run) => run.id === closed.id)).toBe(false);
    } finally {
      await db.close();
    }
  });
});
