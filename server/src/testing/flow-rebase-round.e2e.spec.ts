import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { RunQueriesService } from '../api/run-queries.service';
import { RunRebaseService } from '../api/run-rebase.service';
import { REASON } from '../contract/run-state';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { PipelineService } from '../pipeline/pipeline.service';
import { installScripts, type Script } from '../pipeline/run-driver.spec-helpers';
import { RunRebase } from '../steps/run-rebase';
import {
  child,
  KEY,
  pass,
  requirements,
  seedParent,
  settle,
  task,
  world,
} from '../steps/implement/split-implement.spec-helpers';
import { assertInvariants } from './flow-invariants';

const TASK = `${KEY}-a`;
const MAX_RETURNS = 3;
const STOPPED_SENTENCE = `Automatic retries stopped after ${MAX_RETURNS} attempts. Resume starts another.`;

/** A subtask in a returns loop: checks always send it back to implement, and implement goes on to checks. */
describe('a relaunch after a rebase starts a new round of returns', () => {
  async function boot() {
    const booted = await world({ MAX_RETURNS: String(MAX_RETURNS) });
    const { app } = booted;
    await seedParent(app, [task('a')]);
    await pass(app);
    const run = await child(app, 'a');
    writeRunState(run, { status: 'waiting', currentStep: 'checks' });
    await storeRun(app.app.get(RunRepository), run);
    await app.app.get(DocumentRepository).putDocument(run, 'requirements', requirements);
    // The rebase moves the run onto the new head and back to checks, as the real one does for a subtask.
    jest.spyOn(app.app.get(RunRebase), 'rebase').mockImplementation(async (key) => {
      const moved = (await app.app.get(RunRepository).findRun(key))!;
      writeRunState(moved, { status: 'waiting', currentStep: 'checks' });
      await storeRun(app.app.get(RunRepository), moved);
      return 'start';
    });
    return booted;
  }

  const visitsOf = async (app: Awaited<ReturnType<typeof boot>>['app'], step: string) => {
    const run = (await app.app.get(RunRepository).findRun(TASK))!;
    return (await app.app.get(VisitRepository).listStats(run.id)).filter((stat) => stat.step === step).length;
  };

  const sentence = async (app: Awaited<ReturnType<typeof boot>>['app']) =>
    (await app.app.get(RunQueriesService).flow(TASK)).sentence;

  const back: Script = () => ({ outcome: 'waiting', exitCode: 0, moveTo: 'implement' });
  const onward: Script = () => ({ outcome: 'waiting', exitCode: 0, moveTo: 'checks' });
  const passed: Script = () => ({ outcome: 'ok', exitCode: 0, moveTo: 'pipeline' });

  it('takes a queued rebase at the end of implement without spending the visits before it', async () => {
    const { app } = await boot();
    try {
      let checks = 0;
      installScripts(
        app,
        {
          checks: (_visit, ctx) => {
            checks += 1;
            return checks < MAX_RETURNS + 1 ? back(checks, ctx) : passed(checks, ctx);
          },
          implement: async (visit, ctx) => {
            // The parent sends the rebase while the second implement runs.
            if (visit === MAX_RETURNS - 1) {
              await app.app
                .get(DocumentRepository)
                .putDocument(ctx.opened.run, 'pending_rebase', 'rebased after b merged');
            }
            return onward(visit, ctx);
          },
          pipeline: () => ({ outcome: 'ok', exitCode: 0 }),
        },
        ['checks', 'implement', 'pipeline'],
      );

      await app.app.get(PipelineService).runThrough(TASK, { auto: true });
      await settle(app);

      expect(await visitsOf(app, 'checks')).toBe(MAX_RETURNS + 1);
      expect(await visitsOf(app, 'pipeline')).toBe(1);
      expect(storedState((await app.app.get(RunRepository).findRun(TASK))!).reason?.code).not.toBe(REASON.loopLimit);
      expect(await sentence(app)).not.toBe(STOPPED_SENTENCE);
      await assertInvariants(app);
    } finally {
      await app.close();
    }
  });

  it('still blocks with LOOP_LIMIT after the relaunch once the run has returned MAX_RETURNS times on its own', async () => {
    const { app } = await boot();
    try {
      installScripts(
        app,
        {
          checks: back,
          implement: async (visit, ctx) => {
            if (visit === MAX_RETURNS - 1) {
              await app.app
                .get(DocumentRepository)
                .putDocument(ctx.opened.run, 'pending_rebase', 'rebased after b merged');
            }
            return onward(visit, ctx);
          },
        },
        ['checks', 'implement'],
      );

      await app.app.get(PipelineService).runThrough(TASK, { auto: true });
      await settle(app);

      // Two checks before the rebase, the relaunched one, then MAX_RETURNS of the run's own.
      expect(await visitsOf(app, 'checks')).toBe(MAX_RETURNS - 1 + 1 + MAX_RETURNS);
      expect(storedState((await app.app.get(RunRepository).findRun(TASK))!).reason?.code).toBe(REASON.loopLimit);
      expect(await sentence(app)).toBe(STOPPED_SENTENCE);
      await assertInvariants(app);
    } finally {
      await app.close();
    }
  });

  it('starts a new round for an idle subtask rebased through the rebase service', async () => {
    const { app } = await boot();
    try {
      installScripts(
        app,
        {
          checks: back,
          // The second implement waits on itself, so the run stops idle before a person rebases it.
          implement: (visit, ctx) =>
            visit === MAX_RETURNS - 1 ? { outcome: 'waiting', exitCode: 0 } : onward(visit, ctx),
        },
        ['checks', 'implement'],
      );
      await app.app.get(PipelineService).runThrough(TASK, { auto: true });
      await settle(app);
      expect(await visitsOf(app, 'checks')).toBe(MAX_RETURNS - 1);

      // world() only records the start of a subtask; this one reaches the real driver, as a person's Rebase does.
      const started = PipelineService.prototype.startDetached.bind(app.pipeline);
      jest.spyOn(app.pipeline, 'startDetached').mockImplementation((key, ...rest) => started(key, ...rest));
      await app.app.get(RunRebaseService).rebase(TASK);
      await app.app.get(PipelineService).whenIdle(TASK);
      await settle(app);

      expect(await visitsOf(app, 'checks')).toBe(MAX_RETURNS - 1 + 1 + MAX_RETURNS);
      expect(storedState((await app.app.get(RunRepository).findRun(TASK))!).reason?.code).toBe(REASON.loopLimit);
      await assertInvariants(app);
    } finally {
      await app.close();
    }
  });
});
