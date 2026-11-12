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

const KEY = 'PROJ-700';
const GB = 1024 ** 3;

describe('reconciler waits and automatic tries', () => {
  let app: TestApp | null = null;
  let accept: jest.SpyInstance;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  async function boot(sandbox: NonNullable<Parameters<typeof createTestApp>[0]>['sandbox'] = {}): Promise<TestApp> {
    app = await createTestApp({ sandbox });
    accept = jest.spyOn(app.app.get(CommandService), 'accept').mockImplementation(() => Promise.resolve({} as never));
    return app;
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
      expect(accept).not.toHaveBeenCalled();

      world.clock.advance(300_000);
      await world.app.get(Reconciler).resumeHostUnavailable();
      expect(accept).toHaveBeenCalledWith('resume', KEY, {}, { idempotencyKey: `host-none-${retryAt}` });
    });

    it('never resumes a stopped run', async () => {
      const world = await boot();
      await park(world, 'blocked', 'STOPPED');
      world.clock.advance(600_000);

      await world.app.get(Reconciler).resumeHostUnavailable();

      expect(accept).not.toHaveBeenCalled();
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

        expect(accept).not.toHaveBeenCalled();
        expect(await reasonOf(world)).toMatchObject({ code: 'STOPPED' });
        expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'blocked' });
      },
    );
  });

  describe('docker that does not answer', () => {
    it('waits with DOCKER_UNAVAILABLE, keeps the attempt and starts nothing', async () => {
      const attemptRunning = jest.fn().mockResolvedValue(null);
      const world = await boot({ attemptRunning });
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');

      await world.app.get(Reconciler).reconcile(run);

      const stored = await world.app.get(RunRepository).findRun(KEY);
      expect(stored).toMatchObject({ status: 'waiting', activeAttempt: run.activeAttempt });
      expect(await reasonOf(world)).toMatchObject({ code: ERROR_CODES.DOCKER_UNAVAILABLE });
      expect(await world.app.get(VisitRepository).listStats(stored!.id)).toHaveLength(0);
    });

    it('probes every tick, moves the next try forward and starts nothing while silent', async () => {
      const attemptRunning = jest.fn().mockResolvedValue(null);
      const world = await boot({ attemptRunning });
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await world.app.get(Reconciler).reconcile(run);
      const first = (await reasonOf(world))!.retryAt!;
      const probed = attemptRunning.mock.calls.length;

      world.clock.advance(60_000);
      await world.app.get(Reconciler).resumeDocker();

      expect(attemptRunning.mock.calls.length).toBe(probed + 1);
      expect(Date.parse((await reasonOf(world))!.retryAt!)).toBeGreaterThan(Date.parse(first));
      expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'waiting' });
      expect(accept).not.toHaveBeenCalled();
    });

    it('settles the run as today once docker answers and the container is gone', async () => {
      const attemptRunning = jest.fn().mockResolvedValue(null);
      const world = await boot({ attemptRunning });
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await world.app.get(Reconciler).reconcile(run);
      attemptRunning.mockResolvedValue(false);

      await world.app.get(Reconciler).resumeDocker();

      expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'failed' });
    });

    it('waits for a container that still runs once docker answers', async () => {
      const attemptRunning = jest.fn().mockResolvedValue(null);
      const world = await boot({ attemptRunning });
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await world.app.get(Reconciler).reconcile(run);
      attemptRunning.mockResolvedValue(true);

      await world.app.get(Reconciler).resumeDocker();

      expect(await world.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'running', state: 'recovering' });
    });

    it('resumes a run with no attempt once docker answers', async () => {
      const dockerAnswers = jest.fn().mockResolvedValue(false);
      const world = await boot({ dockerAnswers });
      await park(world, 'waiting', ERROR_CODES.DOCKER_UNAVAILABLE);

      await world.app.get(Reconciler).resumeDocker();
      expect(accept).not.toHaveBeenCalled();

      dockerAnswers.mockResolvedValue(true);
      const waiting = await world.app.get(RunRepository).findRun(KEY);
      await world.app.get(Reconciler).resumeDocker();
      expect(accept).toHaveBeenCalledWith(
        'resume',
        KEY,
        {},
        { idempotencyKey: `docker-none-${deriveState(waiting!).reason?.retryAt}` },
      );
    });

    it('never resumes a stopped run', async () => {
      const world = await boot({ dockerAnswers: jest.fn().mockResolvedValue(true) });
      await park(world, 'blocked', 'STOPPED');

      await world.app.get(Reconciler).resumeDocker();

      expect(accept).not.toHaveBeenCalled();
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
      expect(accept).not.toHaveBeenCalled();

      guard.useFreeBytes(async () => 20 * GB);
      await world.app.get(Reconciler).resumeDiskLow();
      expect(accept).toHaveBeenCalledWith('resume', KEY, {}, { idempotencyKey: 'disk-none-reason' });
    });

    it('never resumes a stopped run', async () => {
      const world = await boot();
      world.app.get(DiskGuard).useFreeBytes(async () => 500 * GB);
      await park(world, 'blocked', 'STOPPED');

      await world.app.get(Reconciler).resumeDiskLow();

      expect(accept).not.toHaveBeenCalled();
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
      expect(accept).toHaveBeenCalledTimes(1);
      expect(accept).toHaveBeenCalledWith('resume', KEY, {}, { idempotencyKey: `relaunch-${attempt}` });
      await world.app.get(Reconciler).reconcileRuns();
      expect(accept).toHaveBeenCalledTimes(1);
    });

    it('stays failed at MAX_LAUNCHES', async () => {
      const world = await boot();
      world.app.get(AppConfig).env.MAX_LAUNCHES = 1;

      const { run } = await cut(world);

      expect(run.status).toBe('failed');
      expect(accept).not.toHaveBeenCalled();
    });

    it('is not relaunched when a Stop is pending', async () => {
      const world = await boot();
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await world.app.get(CommandRepository).accept({ type: 'stop', key: KEY, payload: {}, admit: () => undefined });

      await world.app.get(Reconciler).reconcile(run);

      expect(accept).not.toHaveBeenCalled();
    });

    it('is not relaunched when its run is halted', async () => {
      const world = await boot();
      world.app.get(RunStop).halt(KEY);

      await cut(world);

      expect(accept).not.toHaveBeenCalled();
    });

    it('is not relaunched while docker is silent and no visit was stored', async () => {
      const world = await boot();
      await park(world, 'waiting', ERROR_CODES.DOCKER_UNAVAILABLE);

      await world.app.get(Reconciler).reconcileRuns();

      expect(accept).not.toHaveBeenCalled();
    });
  });

  describe('the timer', () => {
    it('queues one pass, not one per tick, while a direct pass holds the reconciler', async () => {
      const world = await createTestApp({ env: { RECONCILE_MS: '100' } });
      app = world;
      const commands = world.app.get(CommandService);
      const recover = jest.spyOn(commands, 'recover');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      recover.mockImplementationOnce(() => gate);
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

      expect(recover).toHaveBeenCalledTimes(2);
    });
  });
});
