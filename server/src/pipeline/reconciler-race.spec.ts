import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { NEEDS_PERSON } from '../contract/run-state';
import { CommandRepository } from '../history/command.repository';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { save } from '../testing/runs.spec-helpers';
import { createTestApp } from '../testing/test-app';
import type { TestApp } from '../testing/test-app';
import { CommandService } from './command.service';
import { Reconciler } from './reconciler';

const KEY = 'PROJ-701';

describe('reconciler passes', () => {
  let app: TestApp | null = null;

  afterEach(async () => {
    await app?.close();
  });

  /** The real `accept` stores the commands; the resume handler does nothing, so a relaunch starts no step. */
  async function boot(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
    app = await createTestApp(options);
    app.app.get(CommandService).register('resume', () => Promise.resolve(undefined));
    return app;
  }

  async function storedKeys(world: TestApp): Promise<(string | null)[]> {
    const run = await world.app.get(RunRepository).findRun(KEY);
    await world.app.get(CommandService).idle();
    return (await world.app.get(CommandRepository).listForRun(run!.id)).map((command) => command.idempotencyKey);
  }

  it('makes one relaunch command from two passes started together over one dead attempt', async () => {
    const world = await boot();
    const begun = await world.app.get(RunRepository).begin(KEY, 'implement');
    const reconciler = world.app.get(Reconciler);

    await Promise.all([reconciler.reconcileRuns(), reconciler.reconcileRuns()]);

    expect(await storedKeys(world)).toEqual([`relaunch-${begun.activeAttempt}`]);
  });

  it('relaunches a run cut three times twice and leaves it failed at MAX_LAUNCHES', async () => {
    const world = await boot({ env: { MAX_LAUNCHES: '3' } });
    const runs = world.app.get(RunRepository);
    const reconciler = world.app.get(Reconciler);
    const attempts: (string | null)[] = [];
    for (let launch = 1; launch <= 3; launch += 1) {
      attempts.push((await runs.begin(KEY, 'implement')).activeAttempt);
      await reconciler.reconcileRuns();
    }

    // The test clock is fixed, so the commands share one creation time: compare the keys as a set.
    expect((await storedKeys(world)).sort()).toEqual([`relaunch-${attempts[0]}`, `relaunch-${attempts[1]}`].sort());
    const run = (await runs.findRun(KEY))!;
    expect(run.status).toBe('failed');
    // A failed run stores no reason: its code is STEP_FAILED by default, which the needs-a-person list names.
    expect(deriveState(run)).toEqual({ state: 'failed', reason: null });
    expect(NEEDS_PERSON).toHaveProperty(ERROR_CODES.STEP_FAILED);
  });

  it('resumes a host wait once when two passes reach it together', async () => {
    const world = await boot();
    const runs = world.app.get(RunRepository);
    const run = await save(runs, KEY, 'implement', 'waiting');
    const retryAt = new Date(world.clock.now() - 1000).toISOString();
    writeRunState(run, {
      status: 'waiting',
      activeAttempt: null,
      reason: { code: ERROR_CODES.HOST_UNAVAILABLE, message: 'reason', retryAt },
    });
    await runs.saveRun(run);
    const reconciler = world.app.get(Reconciler);

    await Promise.all([reconciler.reconcileAll(), reconciler.reconcileAll()]);

    expect(await storedKeys(world)).toEqual([`host-none-${retryAt}`]);
  });

  it('starts a call made while a pass runs only after that pass ends', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    let firstAttempt: string | null = null;
    const world = await boot({
      sandbox: {
        attemptRunning: async (attemptId: string) => {
          if (attemptId !== firstAttempt) {
            events.push('second pass settles its run');
            return false;
          }
          events.push('first pass waits');
          await gate;
          events.push('first pass ends');
          return false;
        },
      },
    });
    const runs = world.app.get(RunRepository);
    firstAttempt = (await runs.begin(KEY, 'implement')).activeAttempt;
    const reconciler = world.app.get(Reconciler);

    const first = reconciler.reconcileRuns();
    while (!events.includes('first pass waits')) await new Promise((resolve) => setImmediate(resolve));
    // A run begun now is not in the first pass's list: only the second pass reaches it.
    await runs.begin('PROJ-702', 'implement');
    const second = reconciler.reconcileRuns();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);

    expect(events).toEqual(['first pass waits', 'first pass ends', 'second pass settles its run']);
  });
});
