import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { gitWorktree } from './git-worktree.spec-helpers';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { setBarrierHook } from '../core/barrier';
import type { BarrierName } from '../core/barrier';
import * as delays from '../core/delay';
import { StepEventEntity, StepStatEntity } from '../history/entities';
import type { RunEntity } from '../history/entities';
import { RunHosts } from '../integrations/code-host/run-hosts';
import { CheckCommandRepository } from '../history/check-command.repository';
import { DocumentRepository } from '../history/document.repository';
import { CommandRepository } from '../history/command.repository';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { Reconciler } from '../pipeline/reconciler';
import { BlockAgentRunner } from './result-answer';
import { holdRelaunches } from './relaunch-hold.spec-helpers';
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

/** The relaunch is stored with the visit and its command ends at once, so a case reads the run as the cut left it. */
const endsAtOnce = () => Promise.resolve(undefined);

/**
 * The relaunch command stays executing, as a start does until its step takes the run. A case where the reconciler
 * timer runs holds it so, because a timer pass ends a relaunch whose command ended without a step.
 */
const neverEnds = () => new Promise<undefined>(() => undefined);

/** The keys of the relaunch commands stored for the run, once the executor has taken what it was given. */
async function relaunchKeys(app: TestApp): Promise<string[]> {
  await app.app.get(CommandService).idle();
  const run = await app.app.get(RunRepository).findRun(KEY);
  const stored = await app.app.get(CommandRepository).listForRun(run!.id);
  const keys = stored.flatMap((command) =>
    command.idempotencyKey?.startsWith('relaunch-') ? [command.idempotencyKey] : [],
  );
  return keys.sort();
}

/** Fake timers for the reconciler's setInterval only: the rest of the app keeps real time. */
function fakeIntervalOnly(): void {
  jest.useFakeTimers({
    doNotFake: [
      'Date',
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
    ],
  });
}

/** Fires the fake interval every `everyMs` until the promise settles; a tick that meets a running pass is skipped, so it repeats. */
async function tickUntil(settling: Promise<void>, everyMs: number): Promise<void> {
  let settled = false;
  void settling.then(() => {
    settled = true;
  });
  while (!settled) {
    jest.advanceTimersByTime(everyMs);
    await new Promise<void>((turn) => setImmediate(turn));
  }
}

describe('crash matrix', () => {
  let app: TestApp;

  afterEach(async () => {
    setBarrierHook(null);
    jest.restoreAllMocks();
    await app.close();
    jest.useRealTimers();
  });

  it('after-accept: an accepted command that no process started runs once, by its id', async () => {
    app = await createTestApp();
    const runs = app.app.get(RunRepository);
    const waiting = await runs.openWaiting(KEY, '');
    waiting.currentStep = 'research';
    await storeRun(runs, waiting);
    await app.app.get(DocumentRepository).putDocument(waiting, 'requirements', '{"prompt":"Ship the field"}\n');
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
    holdRelaunches(endsAtOnce);
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
    expect(run).toMatchObject({ status: 'waiting', activeAttempt: null });
    expect(await relaunchKeys(app)).toEqual([`relaunch-${stored.attemptId}`]);
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
    holdRelaunches(endsAtOnce);
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
    expect(await app.app.get(RunRepository).findRun(KEY)).toMatchObject({ status: 'waiting', activeAttempt: null });
    expect(await visits(app)).toMatchObject([
      { status: 'failed', killReason: 'process died', attemptId: run.activeAttempt },
    ]);
  });

  it('a container whose result is lost is killed at once and settled without a wait', async () => {
    holdRelaunches(endsAtOnce);
    const killAttempt = jest.fn().mockResolvedValue(true);
    app = await createTestApp({
      sandbox: {
        attemptRunning: () => Promise.resolve(true),
        attemptAwaited: () => Promise.resolve(false),
        killAttempt,
      },
    });
    const run = await orphan(app, 'checks');

    await app.app.get(Reconciler).reconcile(run);

    expect(killAttempt).toHaveBeenCalledWith(run.activeAttempt);
    const stored = await app.app.get(RunRepository).findRun(KEY);
    expect(stored).toMatchObject({ status: 'waiting', activeAttempt: null });
    expect(stored?.state).not.toBe('recovering');
    expect(await visits(app)).toMatchObject([
      { step: 'checks', status: 'failed', killReason: 'process died', attemptId: run.activeAttempt },
    ]);
    expect(await relaunchKeys(app)).toEqual([`relaunch-${run.activeAttempt}`]);
  });

  it('after a settled cut attempt no check row of it is without an end', async () => {
    holdRelaunches(endsAtOnce);
    app = await createTestApp({
      sandbox: { attemptRunning: () => Promise.resolve(true), attemptAwaited: () => Promise.resolve(false) },
    });
    const run = await orphan(app, 'checks');
    const rows = app.app.get(CheckCommandRepository);
    const base = { runId: run.id, attemptId: run.activeAttempt!, repo: 'demo' };
    await rows.add({
      ...base,
      command: 'npm test',
      commandIndex: 0,
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await rows.add({ ...base, command: 'npm run lint', commandIndex: 1 });
    await rows.add({
      ...base,
      command: 'npm run build',
      commandIndex: 2,
      status: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      exitCode: 0,
    });
    await rows.add({ ...base, command: 'npm run docs', commandIndex: 3, status: 'skipped', skipped: 1 });

    await app.app.get(Reconciler).reconcile(run);

    const [visit] = await visits(app);
    expect((await rows.list(run.id)).map((row) => [row.status, row.exitCode, row.endedAt])).toEqual([
      ['interrupted', null, visit.finishedAt],
      ['interrupted', null, visit.finishedAt],
      ['passed', 0, '2026-01-01T00:01:00.000Z'],
      ['skipped', null, null],
    ]);
  });

  it('after-container-create: a container that exited without a result gives an interrupted visit', async () => {
    holdRelaunches(endsAtOnce);
    app = await createTestApp();
    const run = await orphan(app);

    await app.app.get(Reconciler).reconcile(run);

    expect(await visits(app)).toMatchObject([
      { status: 'failed', killReason: 'process died', attemptId: run.activeAttempt },
    ]);
    expect((await app.app.get(RunRepository).findRun(KEY))?.status).toBe('waiting');
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
    const probes: boolean[] = [];
    const attemptRunning = jest.fn(() => {
      probes.push(true);
      return Promise.resolve(null);
    });
    const waited: number[] = [];
    jest.spyOn(delays, 'delay').mockImplementation((ms) => {
      waited.push(ms);
      return Promise.resolve();
    });
    app = await createTestApp({ sandbox: { attemptRunning } });
    const run = await orphan(app);

    await app.app.get(Reconciler).reconcile(run);

    expect(probes).toHaveLength(3);
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
    holdRelaunches(endsAtOnce);
    const reconciled: string[] = [];
    const reconcile = Reflect.get<Reconciler, 'reconcile'>(Reconciler.prototype, 'reconcile');
    jest.spyOn(Reconciler.prototype, 'reconcile').mockImplementation(function (this: Reconciler, ...args) {
      reconciled.push(args[0].key);
      return reconcile.apply(this, args);
    });
    app = await createTestApp();
    await orphan(app);
    app = await app.restart();

    expect(reconciled).toEqual([KEY]);
    expect((await app.app.get(RunRepository).findRun(KEY))?.status).toBe('waiting');
  });

  it('the timer reaches the same reconcile and finds a dead owner without a restart', async () => {
    holdRelaunches(neverEnds);
    fakeIntervalOnly();
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
    await tickUntil(ticked, 50);

    const run = await runs.findRun(KEY);
    expect(run?.status).toBe('waiting');
    const stored = await app.app.get(CommandRepository).listForRun(run!.id);
    expect(stored.map((command) => command.idempotencyKey)).toEqual([`relaunch-${begun.activeAttempt}`]);
  });

  it('the recovery wait does not count the time the host slept between two timer ticks', async () => {
    const killAttempt = jest.fn().mockResolvedValue(true);
    fakeIntervalOnly();
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
    await tickUntil(entering, 100);
    expect((await runs.findRun(KEY))?.state).toBe('recovering');

    app.clock.advance(600_000);
    await tickUntil(nextTicks(2), 100);

    expect(killAttempt).not.toHaveBeenCalled();
    expect((await runs.findRun(KEY))?.state).toBe('recovering');
  });

  it('after-push: a merge request the host already has is stored and never opened again', async () => {
    const found = { project: 'group/app', iid: 7, url: 'https://code.example/group/app/-/merge_requests/7' };
    const openMergeRequest = jest.fn();
    const lookups: unknown[] = [];
    const findMergeRequest = jest.fn((query: unknown) => {
      lookups.push(query);
      return Promise.resolve({ record: found, httpCalls: [] });
    });
    jest.spyOn(RunHosts.prototype, 'byName').mockReturnValue({ findMergeRequest, openMergeRequest } as never);
    jest.spyOn(RunHosts.prototype, 'requiredCredentials').mockReturnValue({} as never);
    app = await createTestApp();
    const runs = app.app.get(RunRepository);
    const documents = app.app.get(DocumentRepository);
    const run = await orphan(app, 'merge-request');
    run.codeHost = 'gitlab';
    await storeRun(runs, run);
    await documents.putDocument(run, 'pipeline_ref', 'project: group/app\nref: feature/x\nsha: abc\n');
    const reconciler = app.app.get(Reconciler);

    await reconciler.reconcile(run);

    expect(lookups).toEqual([{ project: 'group/app', source: 'feature/x' }]);
    expect(await documents.latestBody(KEY, 'merge_request')).toContain('iid: 7');
    expect(openMergeRequest).not.toHaveBeenCalled();
    const stored = await documents.latestBody(KEY, 'merge_request');
    await reconciler.reconcileRuns();
    expect(await documents.latestBody(KEY, 'merge_request')).toBe(stored);
    expect(lookups).toEqual([{ project: 'group/app', source: 'feature/x' }]);
  });

  it('a command that was executing when its run finished is confirmed, not failed', async () => {
    app = await createTestApp();
    const runs = app.app.get(RunRepository);
    const run = await runs.openWaiting(KEY, '');
    const commands = app.app.get(CommandRepository);
    const { command } = await commands.accept({ type: 'resume', key: KEY, payload: {}, admit: () => undefined });
    await commands.start(command.id);
    run.status = 'done';
    await storeRun(runs, run);

    await app.app.get(Reconciler).reconcileCommands();

    expect((await commands.find(command.id))?.state).toBe('succeeded');
  });

  it('a dead step keeps its process died visit, its command ends server restarted and the relaunch is a new command', async () => {
    holdRelaunches(endsAtOnce);
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
    expect(await relaunchKeys(app)).toEqual([`relaunch-${dead.activeAttempt}`]);
  });

  it('a merge request step that died after the push has its merge request stored before the relaunch', async () => {
    const found = { project: 'group/app', iid: 7, url: 'https://code.example/group/app/-/merge_requests/7' };
    const findMergeRequest = jest.fn().mockResolvedValue({ record: found, httpCalls: [] });
    jest.spyOn(RunHosts.prototype, 'byName').mockReturnValue({ findMergeRequest } as never);
    jest.spyOn(RunHosts.prototype, 'requiredCredentials').mockReturnValue({} as never);
    app = await createTestApp();
    const documents = app.app.get(DocumentRepository);
    const stored: (string | null)[] = [];
    app.app.get(CommandService).register('resume', async () => {
      stored.push(await documents.latestBody(KEY, 'merge_request'));
    });
    const run = await orphan(app, 'merge-request');
    run.codeHost = 'gitlab';
    await storeRun(app.app.get(RunRepository), run);
    await documents.putDocument(run, 'pipeline_ref', 'project: group/app\nref: feature/x\nsha: abc\n');

    await app.app.get(Reconciler).reconcile(run);
    await app.app.get(CommandService).idle();

    expect(stored).toEqual([expect.stringContaining('iid: 7')]);
  });

  it('a step that kills the server on every launch is relaunched until MAX_LAUNCHES, then stays failed', async () => {
    holdRelaunches(endsAtOnce);
    app = await createTestApp({ env: { MAX_LAUNCHES: '3' } });
    const runs = app.app.get(RunRepository);
    const reconciler = app.app.get(Reconciler);
    const attempts: (string | null)[] = [];
    for (let launch = 1; launch <= 3; launch += 1) {
      attempts.push((await runs.begin(KEY, 'implement')).activeAttempt);
      await reconciler.reconcileRuns();
    }

    expect(await relaunchKeys(app)).toEqual([`relaunch-${attempts[0]}`, `relaunch-${attempts[1]}`].sort());
    expect((await runs.findRun(KEY))?.status).toBe('failed');
  });

  it('two passes started together over one dead attempt make one relaunch command', async () => {
    app = await createTestApp();
    await app.app.get(RunRepository).begin(KEY, 'implement');
    const reconciler = app.app.get(Reconciler);

    await Promise.all([reconciler.reconcileRuns(), reconciler.reconcileRuns()]);

    const [dead] = await visits(app);
    expect((await relaunchKeys(app)).filter((key) => key === `relaunch-${dead.attemptId}`)).toHaveLength(1);
  });

  it('a reviewer killed after it sent a valid block still counts, and the next pass runs no reviewer again', async () => {
    const blocks = new BlockAgentRunner();
    app = await createTestApp({ realReview: true, blocks });
    const runs = app.app.get(RunRepository);
    const documents = app.app.get(DocumentRepository);
    gitWorktree(join(app.root, 'worktrees', KEY, 'billing-api'));
    const seeded = await runs.begin(KEY, 'code-review');
    seeded.status = 'waiting';
    seeded.currentStep = 'implement-improve';
    await storeRun(runs, seeded);
    await documents.putDocument(seeded, 'requirements', `${JSON.stringify({ prompt: 'Ship the field\n' })}\n`);
    await documents.putDocument(seeded, 'repos', 'billing-api\n');
    await documents.putDocument(seeded, 'implementation', '- changed the field parser\n');
    const delegate = blocks.run.bind(blocks);
    jest.spyOn(blocks, 'run').mockImplementation(async (input: { step: string; outputFile?: string }) => {
      const answered = await delegate(input);
      if (input.step !== 'code-review-code' || !input.outputFile) return answered;
      // The process sent its block and was killed before it exited.
      mkdirSync(join(app.root, 'data'), { recursive: true });
      writeFileSync(
        input.outputFile,
        `${JSON.stringify({ type: 'result', result: answered.responseText })}\nprocess killed: time\n`,
      );
      return { ...answered, killReason: 'time', exitCode: 1 };
    });

    const killed = await app.pipeline.step('code-review', KEY);
    expect(killed.exitCode).toBe(1);
    expect(killed.message).toContain('process killed');
    expect(await documents.latestBody(KEY, 'review_code')).toBeNull();

    jest.restoreAllMocks();
    blocks.steps.length = 0;
    const done = await app.pipeline.step('code-review', KEY);

    expect(done.exitCode).toBe(0);
    expect(blocks.steps).toEqual(['code-review-report']);
    expect(JSON.parse((await documents.latestBody(KEY, 'review_code_result')) ?? '{}').decision).toBe('ok');
    expect((await runs.findRun(KEY))?.currentStep).toBe('commit');
  });
});
