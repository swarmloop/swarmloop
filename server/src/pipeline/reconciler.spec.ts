import 'reflect-metadata';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import type { StepEvent } from '../contract/step-events';
import { AppConfig } from '../config/env';
import { attemptOutputPath } from '../core/attempt-output';
import { StepRegistry } from '../steps/step.registry';
import { deriveState, writeRunState } from '../history/run-state';
import { RunStop } from '../agent/run-stop';
import { CommandRepository } from '../history/command.repository';
import { interruptionSentence, readInterruption } from '../contract/interruption';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { DataSource } from 'typeorm';
import { StepEventLog } from '../history/step-event.log';
import { RunQueriesService } from '../api/run-queries.service';
import { LiveHub } from '../live/live.hub';
import { recordRunWrites } from '../testing/run-writes.spec-helpers';
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
    // A relaunch is stored with the visit and held here: the resume handler does nothing, so no step starts.
    app.app.get(CommandService).register('resume', () => Promise.resolve(undefined));
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

      const stored = (await world.app.get(RunRepository).findRun(KEY))!;
      expect(stored.status).toBe('waiting');
      const [visit] = await world.app.get(VisitRepository).listStats(stored.id);
      expect(visit).toMatchObject({ status: 'failed', killReason: 'process died' });
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

  describe('Stop on a usage-limit wait', () => {
    it('never resumes a stopped run', async () => {
      const world = await boot();
      await park(world, 'waiting', ERROR_CODES.RUNTIME_LIMIT);

      await expect(world.app.get(PipelineService).stop(KEY)).resolves.toMatchObject({ exitCode: 0 });
      world.clock.advance(600_000);
      await world.app.get(Reconciler).resumeLimited();

      expect(accept).not.toHaveBeenCalled();
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

    /** The relaunch commands stored for the run, once the executor has taken what it was given. */
    async function relaunches(world: TestApp, runId: number) {
      await world.app.get(CommandService).idle();
      return (await world.app.get(CommandRepository).listForRun(runId)).filter((command) =>
        command.idempotencyKey?.startsWith('relaunch-'),
      );
    }

    it('is relaunched once while failed launches are below MAX_LAUNCHES', async () => {
      const world = await boot();
      const { run, attempt } = await cut(world);

      expect(run.status).toBe('waiting');
      expect((await relaunches(world, run.id)).map((command) => [command.type, command.idempotencyKey])).toEqual([
        ['resume', `relaunch-${attempt}`],
      ]);
      await world.app.get(Reconciler).reconcileRuns();
      expect(await relaunches(world, run.id)).toHaveLength(1);
    });

    it('records every saved state between the cut attempt and the relaunch, none failed', async () => {
      const world = await boot();
      const begun = await world.app.get(RunRepository).begin(KEY, 'implement');
      const writes = recordRunWrites(world.app.get(DataSource));
      try {
        await world.app.get(Reconciler).reconcile(begun);
      } finally {
        writes.stop();
      }

      const run = (await world.app.get(RunRepository).findRun(KEY))!;
      expect(writes.statuses.at(-1)).toBe('waiting');
      expect(writes.statuses).not.toContain('failed');
      const [command] = await relaunches(world, run.id);
      expect(command).toMatchObject({ type: 'resume', idempotencyKey: `relaunch-${begun.activeAttempt}` });
    });

    it('stores the interruption note with the decision in the visit', async () => {
      const world = await boot();
      const runs = world.app.get(RunRepository);
      const lastVisit = async () => {
        const run = (await runs.findRun(KEY))!;
        const visit = (await world.app.get(VisitRepository).listStats(run.id)).at(-1)!;
        const notes = (await world.app.get(DocumentRepository).listDocuments(run.id)).filter(
          (document) => document.kind === 'interruption' && document.stepStatId === visit.id,
        );
        return { run, visit, note: notes.length ? readInterruption(notes[0].body) : null };
      };

      await cut(world);
      let seen = await lastVisit();
      expect(seen.note).toEqual({ at: seen.visit.finishedAt, relaunched: true });

      await cut(world);
      await cut(world);
      seen = await lastVisit();
      expect(seen.run.status).toBe('failed');
      expect(seen.note).toEqual({ at: seen.visit.finishedAt, relaunched: false, cause: 'limit', limit: 3 });
    });

    it('stores a stop note when a Stop is pending, and none for a visit with no dead attempt', async () => {
      const world = await boot();
      const runs = world.app.get(RunRepository);
      const run = await runs.begin(KEY, 'implement');
      await world.app.get(CommandRepository).accept({ type: 'stop', key: KEY, payload: {}, admit: () => undefined });
      await world.app.get(Reconciler).reconcile(run);

      const stopped = (await runs.findRun(KEY))!;
      const visit = (await world.app.get(VisitRepository).listStats(stopped.id)).at(-1)!;
      const stored = await world.app.get(DocumentRepository).listDocuments(stopped.id);
      const note = stored.find((document) => document.kind === 'interruption' && document.stepStatId === visit.id);
      expect(readInterruption(note!.body)).toEqual({ at: visit.finishedAt, relaunched: false, cause: 'stop' });

      const other = await save(runs, 'PROJ-701', 'implement', 'running');
      writeRunState(other, { status: 'running', activeAttempt: null });
      await runs.saveRun(other);
      await world.app.get(Reconciler).reconcile(other);
      const bare = (await runs.findRun('PROJ-701'))!;
      const documents = await world.app.get(DocumentRepository).listDocuments(bare.id);
      expect(documents.some((document) => document.kind === 'error')).toBe(true);
      expect(documents.some((document) => document.kind === 'interruption')).toBe(false);
    });

    it('stays failed at MAX_LAUNCHES', async () => {
      const world = await boot();
      world.app.get(AppConfig).env.MAX_LAUNCHES = 1;

      const { run } = await cut(world);

      expect(run.status).toBe('failed');
      expect(await relaunches(world, run.id)).toHaveLength(0);
    });

    it('is not relaunched when a Stop is pending', async () => {
      const world = await boot();
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      await world.app.get(CommandRepository).accept({ type: 'stop', key: KEY, payload: {}, admit: () => undefined });

      await world.app.get(Reconciler).reconcile(run);

      const stored = (await world.app.get(RunRepository).findRun(KEY))!;
      expect(stored.status).toBe('failed');
      expect(await relaunches(world, stored.id)).toHaveLength(0);
    });

    it('does not relaunch when a Stop arrives while the dead attempt is settled', async () => {
      const world = await boot();
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      const events = world.app.get(StepEventLog);
      const lastOfAttempt = events.lastOfAttempt.bind(events);
      jest.spyOn(events, 'lastOfAttempt').mockImplementation(async (...args) => {
        await world.app.get(CommandRepository).accept({ type: 'stop', key: KEY, payload: {}, admit: () => undefined });
        return lastOfAttempt(...args);
      });

      await world.app.get(Reconciler).reconcile(run);

      const stored = (await world.app.get(RunRepository).findRun(KEY))!;
      expect(stored.status).toBe('failed');
      expect(await relaunches(world, stored.id)).toHaveLength(0);
    });

    it('does not relaunch when a Stop arrives while the dead attempt is charged', async () => {
      const world = await boot();
      const run = await world.app.get(RunRepository).begin(KEY, 'implement');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let charging: () => void = () => undefined;
      const began = new Promise<void>((resolve) => {
        charging = resolve;
      });
      world.app.get(StepRegistry).get('implement')!.charge = async () => {
        charging();
        await gate;
        return null;
      };

      const settled = world.app.get(Reconciler).reconcile(run);
      await began;
      await world.app.get(CommandRepository).accept({ type: 'stop', key: KEY, payload: {}, admit: () => undefined });
      release();
      await settled;

      const stored = (await world.app.get(RunRepository).findRun(KEY))!;
      expect(stored.status).toBe('failed');
      expect(await relaunches(world, stored.id)).toHaveLength(0);
      const visit = (await world.app.get(RunQueriesService).step(KEY, 'implement')).visits.at(-1);
      expect(visit?.interruption).toMatchObject({ relaunched: false, cause: 'stop' });
    });

    it('records the interruption of an attempt that left its final result, so its transcript shows the note', async () => {
      const world = await boot();
      const begun = await world.app.get(RunRepository).begin(KEY, 'implement');
      const attemptId = begun.activeAttempt!;
      await mkdir(join(world.root, 'data'), { recursive: true });
      await writeFile(
        attemptOutputPath(world.root, KEY, 'implement', attemptId),
        '{"type":"result","subtype":"success"}\n',
      );
      // What its step stored before the server died: it started and its agent returned, but it recorded no end.
      const stored = (seq: number, rest: object) =>
        ({
          payloadVersion: 1,
          eventId: `event-${seq}`,
          runId: begun.id,
          attemptId,
          step: 'implement',
          seq,
          occurredAt: world.clock.iso(),
          parentSpanId: null,
          ...rest,
        }) as StepEvent;
      const log = world.app.get(StepEventLog);
      await log.append([
        stored(1, { kind: 'attempt.started', stepKind: 'agent', agent: null }),
        stored(2, {
          kind: 'agent.finished',
          runtime: 'fake',
          model: 'model',
          tools: 'write',
          chatId: null,
          resumed: false,
          killReason: null,
          tokensIn: 0,
          tokensOut: 0,
          usd: 0,
        }),
      ]);

      await world.app.get(Reconciler).reconcile(begun);

      const own = (await log.page(begun.id, { step: 'implement' })).events.filter(
        (event) => event.attemptId === attemptId,
      );
      expect(own.at(-1)).toMatchObject({ kind: 'attempt.interrupted', route: 'process died' });
      const visit = (await world.app.get(RunQueriesService).step(KEY, 'implement')).visits.at(-1);
      expect(visit).toMatchObject({ killReason: 'process died', interruption: { relaunched: true } });
    });

    it('is not relaunched when its run is halted', async () => {
      const world = await boot();
      world.app.get(RunStop).halt(KEY);

      const { run } = await cut(world);

      expect(run.status).toBe('failed');
      expect(await relaunches(world, run.id)).toHaveLength(0);
    });

    it('is not relaunched while docker is silent and no visit was stored', async () => {
      const world = await boot();
      const parked = await park(world, 'waiting', ERROR_CODES.DOCKER_UNAVAILABLE);

      await world.app.get(Reconciler).reconcileRuns();

      expect(await relaunches(world, parked.id)).toHaveLength(0);
      expect((await world.app.get(RunRepository).findRun(KEY))!.status).toBe('waiting');
    });
  });

  describe('a relaunch that ends before its step takes the run', () => {
    async function cutRun(world: TestApp) {
      const begun = await world.app.get(RunRepository).begin(KEY, 'implement');
      await world.app.get(Reconciler).reconcile(begun);
      return (await world.app.get(RunRepository).findRun(KEY))!;
    }

    /** The note of the run's latest visit, as its page serves it. */
    async function noteOf(world: TestApp) {
      const visits = (await world.app.get(RunQueriesService).step(KEY, 'implement')).visits;
      return visits.at(-1)?.interruption;
    }

    /** A resume handler that never ends: its command stays executing and no step starts. Resolves when it began. */
    function holdResume(world: TestApp): Promise<void> {
      return new Promise((began) => {
        world.app.get(CommandService).register('resume', () => {
          began();
          return new Promise<undefined>(() => undefined);
        });
      });
    }

    it('reads queued with no action while the relaunch executes, on the page and in the list', async () => {
      const world = await boot();
      const began = holdResume(world);
      await cutRun(world);
      await began;

      const queries = world.app.get(RunQueriesService);
      expect(await queries.flow(KEY)).toMatchObject({ state: 'queued', actions: [] });
      expect((await queries.list()).runs.find((item) => item.key === KEY)).toMatchObject({ state: 'queued' });
    });

    it('is left alone while its command executes', async () => {
      const world = await boot();
      const began = holdResume(world);
      await cutRun(world);
      await began;

      await world.app.get(Reconciler).reconcileAll();

      expect((await world.app.get(RunRepository).findRun(KEY))!.status).toBe('waiting');
      expect(await noteOf(world)).toMatchObject({ relaunched: true });
    });

    it('is left alone while a step of this process holds the run, then ends when none does', async () => {
      const world = await boot();
      await cutRun(world);
      await world.app.get(CommandService).idle();

      await world.app.get(Reconciler).start(() => true);
      await world.app.get(Reconciler).reconcileAll();
      expect((await world.app.get(RunRepository).findRun(KEY))!.status).toBe('waiting');

      await world.app.get(Reconciler).start(() => false);
      await world.app.get(Reconciler).reconcileAll();
      expect((await world.app.get(RunRepository).findRun(KEY))!.status).toBe('failed');
    });

    it('ends failed, waiting for a person, with a note that says so, when its command fails', async () => {
      const world = await boot();
      world.app.get(CommandService).register('resume', () => Promise.reject(new Error('prompt is missing')));
      await cutRun(world);
      await world.app.get(CommandService).idle();

      await world.app.get(Reconciler).reconcileAll();

      const queries = world.app.get(RunQueriesService);
      expect(await queries.flow(KEY)).toMatchObject({ state: 'failed', actions: expect.arrayContaining(['resume']) });
      const note = await noteOf(world);
      expect(note).toMatchObject({ relaunched: false, cause: 'start' });
      expect(interruptionSentence(note!, (iso) => iso.slice(11, 16))).toContain(
        'Not started again: the server could not start it. Resume, Replay or Skip.',
      );
      const again = (await world.app.get(RunRepository).findRun(KEY))!.revision;
      await world.app.get(Reconciler).reconcileAll();
      expect((await world.app.get(RunRepository).findRun(KEY))!.revision).toBe(again);
    });

    it('tells the dashboard when it ends a relaunch, so the run does not stay on Working', async () => {
      const world = await boot();
      world.app.get(CommandService).register('resume', () => Promise.reject(new Error('prompt is missing')));
      await cutRun(world);
      await world.app.get(CommandService).idle();
      const changed: string[] = [];
      const stop = world.app.get(LiveHub).onChanged((key) => changed.push(key));

      await world.app.get(Reconciler).reconcileAll();
      stop();

      expect(changed).toContain(KEY);
    });

    it('ends failed with the stop note when a Stop took the place of its command', async () => {
      const world = await boot();
      jest.spyOn(CommandService.prototype, 'runAccepted').mockResolvedValue();
      await cutRun(world);
      await world.app.get(CommandRepository).accept({ type: 'stop', key: KEY, payload: {}, admit: () => undefined });

      await world.app.get(Reconciler).reconcileAll();

      expect((await world.app.get(RunRepository).findRun(KEY))!.status).toBe('failed');
      expect(await noteOf(world)).toMatchObject({ relaunched: false, cause: 'stop' });
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
