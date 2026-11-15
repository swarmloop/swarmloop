import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { AppConfig } from '../config/env';
import { deriveState, writeRunState } from '../history/run-state';
import { RunStop } from '../agent/run-stop';
import { CommandRepository } from '../history/command.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { createTestApp } from '../testing/test-app';
import type { TestApp } from '../testing/test-app';
import { save } from '../testing/runs.spec-helpers';
import { CommandService } from './command.service';
import { DiskGuard } from './disk-guard';
import { Reconciler } from './reconciler';
import { PipelineService } from './pipeline.service';

const GB = 1024 ** 3;

type AcceptedCall = [command: string, key: string, args: unknown, options: unknown];

/** What a test changes of the shared sandbox fake; the shared fake answers from it. */
interface SandboxOverrides {
  attemptRunning?: () => Promise<boolean | null>;
  dockerAnswers?: () => Promise<boolean>;
}

describe('reconciler waits and automatic tries', () => {
  let shared: TestApp;
  let overrides: SandboxOverrides = {};
  let accepted: AcceptedCall[] = [];
  let timerApp: TestApp | null = null;
  let counter = 0;
  let KEY = '';
  const envBefore: { MIN_FREE_GB?: number; MAX_LAUNCHES?: number } = {};

  beforeAll(async () => {
    shared = await createTestApp({
      sandbox: {
        attemptRunning: () => overrides.attemptRunning?.() ?? Promise.resolve(false),
        dockerAnswers: () => overrides.dockerAnswers?.() ?? Promise.reject(new Error('no docker answer set')),
      },
    });
    envBefore.MIN_FREE_GB = shared.app.get(AppConfig).env.MIN_FREE_GB;
    envBefore.MAX_LAUNCHES = shared.app.get(AppConfig).env.MAX_LAUNCHES;
  });

  afterAll(async () => {
    await shared.close();
  });

  beforeEach(() => {
    KEY = `PROJ-7${++counter}`;
    overrides = {};
    accepted = [];
    jest.spyOn(shared.app.get(CommandService), 'accept').mockImplementation((...call) => {
      accepted.push(call as unknown as AcceptedCall);
      return Promise.resolve({} as never);
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await timerApp?.close();
    timerApp = null;
    const env = shared.app.get(AppConfig).env;
    env.MIN_FREE_GB = envBefore.MIN_FREE_GB as number;
    env.MAX_LAUNCHES = envBefore.MAX_LAUNCHES as number;
    const runs = shared.app.get(RunRepository);
    const run = await runs.findRun(KEY);
    if (run) {
      writeRunState(run, { status: 'done', activeAttempt: null, reason: null });
      await runs.saveRun(run);
    }
  });

  async function boot(sandbox: SandboxOverrides = {}): Promise<TestApp> {
    overrides = sandbox;
    return shared;
  }

  async function park(world: TestApp, status: string, code: string, extra: { retryAt?: string } = {}) {
    const runs = world.app.get(RunRepository);
    const run = await save(runs, KEY, 'implement', status);
    writeRunState(run, { status, activeAttempt: null, reason: { code, message: 'reason', ...extra } });
    return runs.saveRun(run);
  }

  const reasonOf = async (world: TestApp) => deriveState((await world.app.get(RunRepository).findRun(KEY))!).reason;

  describe('resumeHostUnavailable', () => {
    it('resumes once the next try has passed and not before', async () => {
      const world = await boot();
      const retryAt = new Date(world.clock.now() + 300_000).toISOString();
      await park(world, 'waiting', ERROR_CODES.HOST_UNAVAILABLE, { retryAt });

      await world.app.get(Reconciler).resumeHostUnavailable();
      expect(accepted).toEqual([]);

      world.clock.advance(300_000);
      await world.app.get(Reconciler).resumeHostUnavailable();
      expect(accepted).toEqual([['resume', KEY, {}, { idempotencyKey: `host-none-${retryAt}` }]]);
    });

    it('never resumes a stopped run', async () => {
      const world = await boot();
      await park(world, 'blocked', 'STOPPED');
      world.clock.advance(600_000);

      await world.app.get(Reconciler).resumeHostUnavailable();

      expect(accepted).toEqual([]);
    });
  });

  describe('Stop on an outage wait', () => {
    it.each([ERROR_CODES.HOST_UNAVAILABLE, ERROR_CODES.DOCKER_UNAVAILABLE])(
      'leaves a run waiting on %s stopped, and no automatic try starts it',
      async (code) => {
        const world = await boot({ dockerAnswers: jest.fn().mockResolvedValue(true) });
        await park(world, 'waiting', code, { retryAt: new Date(world.clock.now()).toISOString() });

        await expect(world.app.get(PipelineService).stop(KEY)).resolves.toMatchObject({ exitCode: 0 });
        world.clock.advance(600_000);
        await world.app.get(Reconciler).resumeHostUnavailable();
        await world.app.get(Reconciler).resumeDocker();

        expect(accepted).toEqual([]);
        expect(await reasonOf(world)).toMatchObject({ code: 'STOPPED' });
        expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'blocked' });
      },
    );
  });

  describe('docker that does not answer', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** A reconcile pass that probes a silent docker three times, with the settler's backoff between the probes. */
    async function reconcileThroughBackoff(world: TestApp, run: Awaited<ReturnType<RunRepository['begin']>>) {
      const pass = world.app.get(Reconciler).reconcile(run);
      await jest.advanceTimersByTimeAsync(3_000);
      await pass;
    }
    it('waits with DOCKER_UNAVAILABLE, keeps the attempt and starts nothing', async () => {
      const attemptRunning = jest.fn().mockResolvedValue(null);
      const world = await boot({ attemptRunning });
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');

      await reconcileThroughBackoff(world, run);

      const stored = await world.app.get(RunRepository).findRun(KEY);
      expect(stored).toMatchObject({ status: 'waiting', activeAttempt: run.activeAttempt });
      expect(await reasonOf(world)).toMatchObject({ code: ERROR_CODES.DOCKER_UNAVAILABLE });
      expect(await world.app.get(VisitRepository).listStats(stored!.id)).toHaveLength(0);
    });

    it('probes every tick, moves the next try forward and starts nothing while silent', async () => {
      const probes: string[] = [];
      const attemptRunning = async () => {
        probes.push(KEY);
        return null;
      };
      const world = await boot({ attemptRunning });
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await reconcileThroughBackoff(world, run);
      const first = (await reasonOf(world))!.retryAt!;
      const probed = probes.length;

      world.clock.advance(60_000);
      await world.app.get(Reconciler).resumeDocker();

      expect(probes).toHaveLength(probed + 1);
      expect(Date.parse((await reasonOf(world))!.retryAt!)).toBeGreaterThan(Date.parse(first));
      expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'waiting' });
      expect(accepted).toEqual([]);
    });

    it('settles the run as today once docker answers and the container is gone', async () => {
      const attemptRunning = jest.fn().mockResolvedValue(null);
      const world = await boot({ attemptRunning });
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await reconcileThroughBackoff(world, run);
      attemptRunning.mockResolvedValue(false);

      await world.app.get(Reconciler).resumeDocker();

      expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'failed' });
    });

    it('waits for a container that still runs once docker answers', async () => {
      const attemptRunning = jest.fn().mockResolvedValue(null);
      const world = await boot({ attemptRunning });
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await reconcileThroughBackoff(world, run);
      attemptRunning.mockResolvedValue(true);

      await world.app.get(Reconciler).resumeDocker();

      expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'running', state: 'recovering' });
    });

    it('resumes a run with no attempt once docker answers', async () => {
      const dockerAnswers = jest.fn().mockResolvedValue(false);
      const world = await boot({ dockerAnswers });
      await park(world, 'waiting', ERROR_CODES.DOCKER_UNAVAILABLE);

      await world.app.get(Reconciler).resumeDocker();
      expect(accepted).toEqual([]);

      dockerAnswers.mockResolvedValue(true);
      const waiting = await world.app.get(RunRepository).findRun(KEY);
      await world.app.get(Reconciler).resumeDocker();
      expect(accepted).toEqual([
        ['resume', KEY, {}, { idempotencyKey: `docker-none-${deriveState(waiting!).reason?.retryAt}` }],
      ]);
    });

    it('never resumes a stopped run', async () => {
      const world = await boot({ dockerAnswers: jest.fn().mockResolvedValue(true) });
      await park(world, 'blocked', 'STOPPED');

      await world.app.get(Reconciler).resumeDocker();

      expect(accepted).toEqual([]);
    });
  });

  describe('Stop on a usage-limit wait', () => {
    it('never resumes a stopped run', async () => {
      const world = await boot();
      await park(world, 'waiting', ERROR_CODES.RUNTIME_LIMIT);

      await expect(world.app.get(PipelineService).stop(KEY)).resolves.toMatchObject({ exitCode: 0 });
      world.clock.advance(600_000);
      await world.app.get(Reconciler).resumeLimited();

      expect(accepted).toEqual([]);
      expect(await reasonOf(world)).toMatchObject({ code: 'STOPPED' });
      expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'blocked' });
    });
  });

  describe('resumeDiskLow', () => {
    it('resumes once the free space is above MIN_FREE_GB and not before', async () => {
      const world = await boot();
      world.app.get(AppConfig).env.MIN_FREE_GB = 10;
      const guard = world.app.get(DiskGuard);
      await park(world, 'blocked', ERROR_CODES.DISK_LOW);

      guard.useFreeBytes(async () => 5 * GB);
      await world.app.get(Reconciler).resumeDiskLow();
      expect(accepted).toEqual([]);

      guard.useFreeBytes(async () => 20 * GB);
      await world.app.get(Reconciler).resumeDiskLow();
      expect(accepted).toEqual([['resume', KEY, {}, { idempotencyKey: 'disk-none-reason' }]]);
    });

    it('never resumes a stopped run', async () => {
      const world = await boot();
      world.app.get(DiskGuard).useFreeBytes(async () => 500 * GB);
      await park(world, 'blocked', 'STOPPED');

      await world.app.get(Reconciler).resumeDiskLow();

      expect(accepted).toEqual([]);
    });
  });

  describe('a step cut by a restart', () => {
    /** A run `running` with a dead owner and an attempt: `reconcile` stores its `process died` visit. */
    async function cut(world: TestApp) {
      const begun = await world.app.get(RunRepository).begin(KEY, 'implement');
      await world.app.get(Reconciler).reconcile(begun);
      return { run: (await world.app.get(RunRepository).findRun(KEY))!, attempt: begun.activeAttempt };
    }

    it('is relaunched once while failed launches are below MAX_LAUNCHES', async () => {
      const world = await boot();
      const { run, attempt } = await cut(world);

      expect(run.status).toBe('failed');
      const relaunch = ['resume', KEY, {}, { idempotencyKey: `relaunch-${attempt}` }];
      expect(accepted).toEqual([relaunch]);
      await world.app.get(Reconciler).reconcileRuns();
      expect(accepted).toEqual([relaunch]);
    });

    it('stays failed at MAX_LAUNCHES', async () => {
      const world = await boot();
      world.app.get(AppConfig).env.MAX_LAUNCHES = 1;

      const { run } = await cut(world);

      expect(run.status).toBe('failed');
      expect(accepted).toEqual([]);
    });

    it('is not relaunched when a Stop is pending', async () => {
      const world = await boot();
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await world.app.get(CommandRepository).accept({ type: 'stop', key: KEY, payload: {}, admit: () => undefined });

      await world.app.get(Reconciler).reconcile(run);

      expect(accepted).toEqual([]);
    });

    it('is not relaunched when its run is halted', async () => {
      const world = await boot();
      world.app.get(RunStop).halt(KEY);

      await cut(world);

      expect(accepted).toEqual([]);
    });

    it('is not relaunched while docker is silent and no visit was stored', async () => {
      const world = await boot();
      await park(world, 'waiting', ERROR_CODES.DOCKER_UNAVAILABLE);

      await world.app.get(Reconciler).reconcileRuns();

      expect(accepted).toEqual([]);
    });
  });

  describe('the timer', () => {
    it('queues one pass, not one per tick, while a direct pass holds the reconciler', async () => {
      const world = await createTestApp({ env: { RECONCILE_MS: '100' } });
      timerApp = world;
      const commands = world.app.get(CommandService);
      const recovered: string[] = [];
      const recover = jest.spyOn(commands, 'recover');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      recover.mockImplementation(async () => {
        recovered.push('pass');
        if (recovered.length === 1) await gate;
      });
      const reconciler = world.app.get(Reconciler);
      const direct = reconciler.reconcileAll();
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        reconciler.schedule();
        jest.advanceTimersByTime(500);
      } finally {
        jest.useRealTimers();
      }

      release();
      await direct;
      await reconciler.reconcileRuns();
      await reconciler.reconcileRuns();

      expect(recovered).toEqual(['pass', 'pass']);
    });
  });
});
