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
});
