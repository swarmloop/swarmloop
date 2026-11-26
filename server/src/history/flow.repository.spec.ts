import { PHASES } from '../contract/steps';
import { DataSource } from 'typeorm';
import { FlowEntity } from './entities';
import { FlowRepository } from './flow.repository';
import { repositoryDatabase } from './repository.spec-helpers';
import { RunRepository } from './run.repository';

describe('FlowRepository', () => {
  it('creates a waiting run and reads the updated phase selection from successive launches', async () => {
    const db = await repositoryDatabase();
    try {
      const flows = db.app.get(FlowRepository);
      await flows.noteFlow('run-1', ['planning'], null);
      const run = await db.app.get(RunRepository).findRun('run-1');
      expect(run).toEqual(expect.objectContaining({ status: 'waiting', ownerPid: null, stepStartedAt: null }));
      expect(await flows.activePhases(run!.id)).toEqual(['planning']);
      expect(await flows.listFlows(run!.id)).toEqual([
        expect.objectContaining({ fromStep: null, phases: '["planning"]' }),
      ]);
      await flows.noteFlow('run-1', ['implementation'], 'implement');
      expect(await flows.activePhases(run!.id)).toEqual(['planning', 'implementation']);
      expect((await flows.listFlows(run!.id)).map((row) => row.fromStep)).toEqual([null, 'implement']);
      await db.app.get(DataSource).getRepository(FlowEntity).save({
        runId: run!.id,
        phases: '{',
        fromStep: 'implement',
        createdAt: db.clock.iso(),
      });
      expect(await flows.activePhases(run!.id)).toEqual([...PHASES]);
    } finally {
      await db.close();
    }
  });

  it('marks a launch with its cause and lists the relaunches after a rebase of several runs in one read', async () => {
    const db = await repositoryDatabase();
    try {
      const flows = db.app.get(FlowRepository);
      await flows.noteFlow('run-a', ['planning'], null);
      await flows.noteFlow('run-a', ['checks', 'ci'], 'checks', 'rebase');
      await flows.noteFlow('run-b', ['planning'], null);
      const runs = db.app.get(RunRepository);
      const a = (await runs.findRun('run-a'))!;
      const b = (await runs.findRun('run-b'))!;
      const found = await flows.listRebases([a.id, b.id]);
      expect([...found.keys()]).toEqual([a.id]);
      expect(found.get(a.id)).toEqual([expect.objectContaining({ fromStep: 'checks', cause: 'rebase' })]);
      expect((await flows.listFlows(a.id)).map((row) => row.cause)).toEqual([null, 'rebase']);
    } finally {
      await db.close();
    }
  });
});
