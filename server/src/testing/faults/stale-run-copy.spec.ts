import { LEGACY_MACHINE } from '../../contract/people';
import { settle } from '../../core/pipeline-result';
import { CommandRepository } from '../../history/command.repository';
import { FlowRepository } from '../../history/flow.repository';
import { repositoryDatabase, repositoryVisit } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { closeStep, openStep } from '../../steps/step-run';
import { storeRun } from '../store-run.spec-helpers';

describe('a step that holds a copy of its run', () => {
  it('keeps the title, the generation and the owner that other writers set while the visit ran', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      const flows = db.app.get(FlowRepository);
      const key = 'run-stale';
      await storeRun(runs, runs.newWaitingRun(key, null, LEGACY_MACHINE));
      const opened = await openStep(runs, db.clock, key, 'research');

      await runs.recordTitle((await runs.findRun(key))!, 'A title');
      await runs.bumpGeneration(key);
      await db.app.get(CommandRepository).accept({
        type: 'resume',
        key,
        payload: {},
        takeOver: { login: 'ada', agents: null },
        admit: () => undefined,
      });

      await closeStep({
        runs,
        visits: db.app.get(VisitRepository),
        flows,
        root: db.root,
        clock: db.clock,
        run: opened.run,
        attemptId: opened.attemptId,
        previousStep: opened.previousStep,
        previousStatus: opened.previousStatus,
        step: 'research',
        outcome: 'ok',
        visit: { ...repositoryVisit(), step: 'research' },
        line: 'research done',
        exitCode: 0,
      });

      const settled = settle(
        opened.previousStep,
        opened.previousStatus,
        'research',
        'ok',
        undefined,
        await flows.activePhases(opened.run.id),
      );
      const row = (await runs.findRun(key))!;
      expect(row).toEqual(expect.objectContaining({ ...settled, activeAttempt: null }));
      expect(row).toEqual(
        expect.objectContaining({ title: 'A title', generation: 1, startedBy: 'ada', ownerSince: expect.any(String) }),
      );
      expect(opened.run).toEqual(row);
    } finally {
      await db.close();
    }
  });
});
