import 'reflect-metadata';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { setBarrierHook } from '../core/barrier';
import type { BarrierName } from '../core/barrier';
import * as delays from '../core/delay';
import { StepEventEntity, StepStatEntity } from '../history/entities';
import type { RunEntity } from '../history/entities';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { DocumentRepository } from '../history/document.repository';
import { CommandRepository } from '../history/command.repository';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { Reconciler } from '../pipeline/reconciler';
import { createTestApp } from './test-app';
import type { TestApp } from './test-app';

const KEY = 'PROJ-1';
const RESULT_LINE = '{"type":"result","subtype":"success"}\n';

/** The process stops at the barrier for good, as a crash does. The promise settles when it got there. */
function crashAt(name: BarrierName): Promise<void> {
  return new Promise((reached) => {
    setBarrierHook((at) => {
      if (at !== name) return undefined;
      setBarrierHook(null);
      reached();
      return new Promise<void>(() => undefined);
    });
  });
}

async function visits(app: TestApp): Promise<StepStatEntity[]> {
  return app.app.get<Repository<StepStatEntity>>(getRepositoryToken(StepStatEntity)).find();
}

async function eventCount(app: TestApp): Promise<number> {
  return app.app.get<Repository<StepEventEntity>>(getRepositoryToken(StepEventEntity)).count();
}

/** A run whose step was claimed by a process that has since died: the run is `running` with an attempt. */
async function orphan(app: TestApp, step = 'implement'): Promise<RunEntity> {
  return app.app.get(RunRepository).begin(KEY, step);
}

function writeOutput(app: TestApp, run: RunEntity, body: string): void {
  mkdirSync(join(app.root, 'data'), { recursive: true });
  writeFileSync(join(app.root, 'data', `${KEY}-${run.currentStep}-${run.activeAttempt}-output.txt`), body);
}

/** The relaunch after `process died` is recorded and not run, so a case reads the run as `interrupted` left it. */
function holdRelaunches(): string[] {
  const keys: string[] = [];
  const accept = Reflect.get<CommandService, 'accept'>(CommandService.prototype, 'accept');
  jest.spyOn(CommandService.prototype, 'accept').mockImplementation(function (this: CommandService, ...args) {
    const key = args[3]?.idempotencyKey;
    if (!key?.startsWith('relaunch-')) return accept.apply(this, args);
    keys.push(key);
    return Promise.resolve({} as never);
  });
  return keys;
}

describe('crash matrix', () => {
  let app: TestApp;

  afterEach(async () => {
    setBarrierHook(null);
    jest.restoreAllMocks();
    await app.close();
  });

  it('after-accept: an accepted command that no process started runs once, by its id', async () => {
    app = await createTestApp();
    const runs = app.app.get(RunRepository);
    const waiting = await runs.openWaiting(KEY, '');
    waiting.currentStep = 'research';
    await runs.saveRun(waiting);
    const crashed = crashAt('after-accept');
    void app.app.get(CommandService).accept('resume', KEY, {});
    await crashed;
    const commands = app.app.get(CommandRepository);
    const [accepted] = await commands.pending(waiting.id);
    expect(accepted.state).toBe('accepted');

    app = await app.restart();
    await app.app.get(CommandService).idle();
    await app.app.get(Reconciler).reconcileCommands();
    await app.app.get(CommandService).idle();
    await app.pipeline.whenIdle(KEY);

    expect((await app.app.get(CommandRepository).find(accepted.id))?.state).toBe('succeeded');
    expect(app.runner.steps.filter((step) => step === 'research')).toHaveLength(1);
  });

  it('before-finalize: a step that died before its visit is stored gets an interrupted visit', async () => {
    const relaunched = holdRelaunches();
    app = await createTestApp();
    const crashed = crashAt('before-finalize');
    await app.pipeline.startDetached(KEY, {}, 'research');
    await crashed;
    expect(await visits(app)).toHaveLength(0);

    app = await app.restart();

    const [stored] = await visits(app);
    expect(stored).toMatchObject({ step: 'research', status: 'failed', killReason: 'process died' });
    expect(stored.attemptId).toBeTruthy();
    const run = await app.app.get(RunRepository).findRun(KEY);
    expect(run).toMatchObject({ status: 'failed', activeAttempt: null });
    expect(relaunched).toEqual([`relaunch-${stored.attemptId}`]);
  });

  it('after-finalize: a visit that is stored is left as it is', async () => {
    app = await createTestApp();
    const crashed = crashAt('after-finalize');
    await app.pipeline.startDetached(KEY, {}, 'research');
    await crashed;
    const before = await visits(app);
    expect(before).toHaveLength(1);
    const run = await app.app.get(RunRepository).findRun(KEY);

    app = await app.restart();

    expect(await visits(app)).toEqual(before);
    expect(await app.app.get(RunRepository).findRun(KEY)).toEqual(run);
  });

  it('after-container-create: a container that runs without a result puts the run in recovering, then it is killed', async () => {
    const killAttempt = jest.fn().mockResolvedValue(true);
    app = await createTestApp({ sandbox: { attemptRunning: () => Promise.resolve(true), killAttempt } });
    const run = await orphan(app);
    const reconciler = app.app.get(Reconciler);

    await reconciler.reconcile(run);
    const waiting = await app.app.get(RunRepository).findRun(KEY);
    expect(waiting).toMatchObject({ status: 'running', state: 'recovering' });

    app.clock.advance(599_000);
    await reconciler.reconcile(run);
    expect(killAttempt).not.toHaveBeenCalled();
    expect((await app.app.get(RunRepository).findRun(KEY))?.state).toBe('recovering');

    app.clock.advance(1_000);
    await reconciler.reconcile(run);
    expect(killAttempt).toHaveBeenCalledWith(run.activeAttempt);
    expect(await app.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'failed', activeAttempt: null });
    expect(await visits(app)).toMatchObject([
      { status: 'failed', killReason: 'process died', attemptId: run.activeAttempt },
    ]);
  });

  it('after-container-create: a container that exited without a result gives an interrupted visit', async () => {
    app = await createTestApp();
    const run = await orphan(app);

    await app.app.get(Reconciler).reconcile(run);

    expect(await visits(app)).toMatchObject([
      { status: 'failed', killReason: 'process died', attemptId: run.activeAttempt },
    ]);
    expect((await app.app.get(RunRepository).findRun(KEY))?.status).toBe('failed');
  });

  it('a final result in the output file is finalized while the container still runs', async () => {
    const killAttempt = jest.fn().mockResolvedValue(true);
    app = await createTestApp({ sandbox: { attemptRunning: () => Promise.resolve(true), killAttempt } });
    const run = await orphan(app);
    writeOutput(app, run, `thinking\n${RESULT_LINE}`);

    await app.app.get(Reconciler).reconcile(run);

    expect(killAttempt).not.toHaveBeenCalled();
    expect(await visits(app)).toMatchObject([{ status: 'failed', attemptId: run.activeAttempt }]);
  });

  it('docker silent: read-only probes with backoff, then waiting with DOCKER_UNAVAILABLE, its attempt kept and no visit', async () => {
    const attemptRunning = jest.fn().mockResolvedValue(null);
    const waited: number[] = [];
    jest.spyOn(delays, 'delay').mockImplementation((ms) => {
      waited.push(ms);
      return Promise.resolve();
    });
    app = await createTestApp({ sandbox: { attemptRunning } });
    const run = await orphan(app);

    await app.app.get(Reconciler).reconcile(run);

    expect(attemptRunning).toHaveBeenCalledTimes(3);
    expect(waited).toEqual([1_000, 2_000]);
    const stored = await app.app.get(RunRepository).findRun(KEY);
    expect(stored).toMatchObject({ status: 'waiting', activeAttempt: run.activeAttempt });
    expect(JSON.parse(stored?.stateReason ?? '{}')).toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    expect(await visits(app)).toHaveLength(0);
  });

  it('reconciling twice without new facts changes nothing', async () => {
    app = await createTestApp();
    const run = await orphan(app);
    const reconciler = app.app.get(Reconciler);
    await reconciler.reconcile(run);
    const runs = app.app.get(RunRepository);
    const settled = await runs.findRun(KEY);
    const stored = await visits(app);
    const events = await eventCount(app);

    await reconciler.reconcile(run);
    await reconciler.reconcileRuns();

    expect(await runs.findRun(KEY)).toEqual(settled);
    expect(await visits(app)).toEqual(stored);
    expect(await eventCount(app)).toBe(events);
  });

  it('a run owned by this process with its step in flight is left alone', async () => {
    app = await createTestApp();
    const run = await orphan(app);
    const reconciler = app.app.get(Reconciler);
    await reconciler.start((key) => key === KEY);

    await reconciler.reconcile(run);

    expect((await app.app.get(RunRepository).findRun(KEY))?.status).toBe('running');
  });

  it('startup reconciles each running run through reconcile', async () => {
    holdRelaunches();
    const reconcile = jest.spyOn(Reconciler.prototype, 'reconcile');
    app = await createTestApp();
    await orphan(app);
    app = await app.restart();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((await app.app.get(RunRepository).findRun(KEY))?.status).toBe('failed');
  });

  it('the timer reaches the same reconcile and finds a dead owner without a restart', async () => {
    const relaunched = holdRelaunches();
    app = await createTestApp({ env: { RECONCILE_MS: '50' }, reconcilerTimer: true });
    const reconciler = app.app.get(Reconciler);
    const original = reconciler.reconcile.bind(reconciler);
    const ticked = new Promise<void>((done) => {
      jest.spyOn(reconciler, 'reconcile').mockImplementation(async (run) => {
        await original(run);
        done();
      });
    });
    const runs = app.app.get(RunRepository);
    const begun = await runs.begin(KEY, 'implement');
    await ticked;

    const run = await runs.findRun(KEY);
    expect(run?.status).toBe('failed');
    expect(relaunched).toEqual([`relaunch-${begun.activeAttempt}`]);
  });

  it('the recovery wait does not count the time the host slept between two timer ticks', async () => {
    const killAttempt = jest.fn().mockResolvedValue(true);
    app = await createTestApp({
      env: { RECONCILE_MS: '100' },
      reconcilerTimer: true,
      sandbox: { attemptRunning: () => Promise.resolve(true), killAttempt },
    });
    const reconciler = app.app.get(Reconciler);
    const original = reconciler.reconcile.bind(reconciler);
    let ticks = 0;
    let settle: () => void = () => undefined;
    jest.spyOn(reconciler, 'reconcile').mockImplementation(async (run) => {
      await original(run);
      ticks += 1;
      settle();
    });
    const nextTicks = (count: number): Promise<void> => {
      const target = ticks + count;
      return new Promise((done) => {
        settle = () => ticks >= target && done();
      });
    };
    const runs = app.app.get(RunRepository);
    const entering = nextTicks(1);
    await orphan(app);
    await entering;
    expect((await runs.findRun(KEY))?.state).toBe('recovering');

    app.clock.advance(600_000);
    await nextTicks(2);

    expect(killAttempt).not.toHaveBeenCalled();
    expect((await runs.findRun(KEY))?.state).toBe('recovering');
  });

  it('after-push: a merge request the host already has is stored and never opened again', async () => {
    const found = { project: 'group/app', iid: 7, url: 'https://code.example/group/app/-/merge_requests/7' };
    const openMergeRequest = jest.fn();
    const findMergeRequest = jest.fn().mockResolvedValue({ record: found, httpCalls: [] });
    jest.spyOn(CodeHostRegistry.prototype, 'byName').mockReturnValue({ findMergeRequest, openMergeRequest } as never);
    app = await createTestApp();
    const runs = app.app.get(RunRepository);
    const documents = app.app.get(DocumentRepository);
    const run = await orphan(app, 'merge-request');
    run.codeHost = 'gitlab';
    await runs.saveRun(run);
    await documents.putDocument(run, 'pipeline_ref', 'project: group/app\nref: feature/x\nsha: abc\n');
    const reconciler = app.app.get(Reconciler);

    await reconciler.reconcile(run);

    expect(findMergeRequest).toHaveBeenCalledWith({ project: 'group/app', source: 'feature/x' });
    expect(await documents.latestBody(KEY, 'merge_request')).toContain('iid: 7');
    expect(openMergeRequest).not.toHaveBeenCalled();
    const stored = await documents.latestBody(KEY, 'merge_request');
    await reconciler.reconcileRuns();
    expect(await documents.latestBody(KEY, 'merge_request')).toBe(stored);
    expect(findMergeRequest).toHaveBeenCalledTimes(1);
  });

  it('a command that was executing when its run finished is confirmed, not failed', async () => {
    app = await createTestApp();
    const runs = app.app.get(RunRepository);
    const run = await runs.openWaiting(KEY, '');
    const commands = app.app.get(CommandRepository);
    const { command } = await commands.accept({ type: 'resume', key: KEY, payload: {}, admit: () => undefined });
    await commands.start(command.id);
    run.status = 'done';
    await runs.saveRun(run);

    await app.app.get(Reconciler).reconcileCommands();

    expect((await commands.find(command.id))?.state).toBe('succeeded');
  });

  it('a dead step keeps its process died visit, its command ends server restarted and the relaunch is a new command', async () => {
    const relaunched = holdRelaunches();
    app = await createTestApp();
    const commands = app.app.get(CommandRepository);
    const dead = await orphan(app);
    const { command } = await commands.accept({ type: 'resume', key: KEY, payload: {}, admit: () => undefined });
    await commands.start(command.id);

    await app.app.get(Reconciler).start(() => false);
    await app.app.get(Reconciler).reconcileCommands();

    const [stored] = await visits(app);
    expect(stored).toMatchObject({ step: 'implement', status: 'failed', killReason: 'process died' });
    expect(await commands.find(command.id)).toMatchObject({
      state: 'failed',
      result: expect.stringContaining('server restarted'),
    });
    expect(relaunched).toEqual([`relaunch-${dead.activeAttempt}`]);
  });

  it('a merge request step that died after the push has its merge request stored before the relaunch', async () => {
    const found = { project: 'group/app', iid: 7, url: 'https://code.example/group/app/-/merge_requests/7' };
    const findMergeRequest = jest.fn().mockResolvedValue({ record: found, httpCalls: [] });
    jest.spyOn(CodeHostRegistry.prototype, 'byName').mockReturnValue({ findMergeRequest } as never);
    app = await createTestApp();
    const documents = app.app.get(DocumentRepository);
    const stored: (string | null)[] = [];
    jest.spyOn(CommandService.prototype, 'accept').mockImplementation(async () => {
      stored.push(await documents.latestBody(KEY, 'merge_request'));
      return {} as never;
    });
    const run = await orphan(app, 'merge-request');
    run.codeHost = 'gitlab';
    await app.app.get(RunRepository).saveRun(run);
    await documents.putDocument(run, 'pipeline_ref', 'project: group/app\nref: feature/x\nsha: abc\n');

    await app.app.get(Reconciler).reconcile(run);

    expect(stored).toEqual([expect.stringContaining('iid: 7')]);
  });

  it('a step that kills the server on every launch is relaunched until MAX_LAUNCHES, then stays failed', async () => {
    const relaunched = holdRelaunches();
    app = await createTestApp({ env: { MAX_LAUNCHES: '3' } });
    const runs = app.app.get(RunRepository);
    const reconciler = app.app.get(Reconciler);
    const attempts: (string | null)[] = [];
    for (let launch = 1; launch <= 3; launch += 1) {
      attempts.push((await runs.begin(KEY, 'implement')).activeAttempt);
      await reconciler.reconcileRuns();
    }

    expect(relaunched).toEqual([`relaunch-${attempts[0]}`, `relaunch-${attempts[1]}`]);
    expect((await runs.findRun(KEY))?.status).toBe('failed');
  });
});
