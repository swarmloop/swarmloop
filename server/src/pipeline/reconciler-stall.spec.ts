import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { actionsFor } from '../contract/run-state';
import { CommandRepository } from '../history/command.repository';
import { StepStatEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { EventRepository } from '../history/event.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { ContainerGate } from '../sandbox/container-gate';
import { createTestApp } from '../testing/test-app';
import type { TestApp } from '../testing/test-app';
import { save } from '../testing/runs.spec-helpers';
import { CommandService } from './command.service';
import { Reconciler } from './reconciler';
import { PERSON_RESUME } from './resume-sender';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('a run that stopped moving with no reason', () => {
  let app: TestApp;
  let counter = 0;
  let KEY = '';
  let attempt = 0;
  const holds: (() => void)[] = [];

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    KEY = `PROJ-87${++counter}`;
    app.app.get(CommandService).register('resume', () => Promise.resolve(undefined));
  });

  afterEach(async () => {
    holds.splice(0).forEach((release) => release());
    app.app.get(ContainerGate).resume();
    await app.app.get(Reconciler).start(() => false);
    await app.app.get(CommandService).idle();
    const runs = app.app.get(RunRepository);
    for (const run of await runs.listRuns()) {
      if (run.status === 'done') continue;
      writeRunState(run, { status: 'done', activeAttempt: null, reason: null });
      await runs.saveRun(run);
    }
  });

  const find = async () => (await app.app.get(RunRepository).findRun(KEY))!;

  /** The run is `waiting` with no reason after a visit of `step` that ended now: a step that ended and nothing took the run on. */
  async function stalledAt(step: string): Promise<void> {
    const runs = app.app.get(RunRepository);
    const run = (await runs.findRun(KEY)) ?? (await save(runs, KEY, step, 'waiting'));
    run.currentStep = step;
    await runs.saveRun(run);
    const now = app.clock.iso();
    await app.app.get(VisitRepository).saveStat(
      Object.assign(new StepStatEntity(), {
        runId: run.id,
        step,
        attempt: 1,
        attemptId: `attempt-${++attempt}`,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: 'waiting',
      }),
    );
  }

  /** Moves the fake clock, runs one stall pass and lets the resumes it sent finish. */
  async function after(ms: number): Promise<void> {
    app.clock.advance(ms);
    await app.app.get(Reconciler).resumeStalled();
    await app.app.get(CommandService).idle();
  }

  const commandsOf = async () => app.app.get(CommandRepository).listForRun((await find()).id);
  const tries = async () =>
    (await commandsOf()).filter((command) => command.type === 'resume' && command.payload.includes('stalledAt'));
  const lines = async () =>
    (await app.app.get(EventRepository).listLoops((await find()).id))
      .filter((loop) => loop.counter === 'stall')
      .map((loop) => loop.reason);
  const reasonOf = async () => deriveState(await find()).reason;

  async function personResumes(): Promise<void> {
    app.clock.advance(MINUTE);
    await app.app.get(CommandService).accept('resume', KEY, { ...PERSON_RESUME });
    await app.app.get(CommandService).idle();
  }

  it('is resumed after 15 minutes and not before, with a line in its events', async () => {
    await stalledAt('implement');

    await after(15 * MINUTE - 1);
    expect(await tries()).toHaveLength(0);

    await after(1);
    expect(await tries()).toHaveLength(1);
    expect(await lines()).toEqual(['Stalled for 15 min with no reason; resumed (try 1 of 3)']);
  });

  it('is resumed 30 minutes after the first try and 60 after the second, then goes to a person', async () => {
    await stalledAt('implement');
    await after(15 * MINUTE);
    await stalledAt('implement');
    await after(30 * MINUTE - 1);
    expect(await tries()).toHaveLength(1);
    await after(1);
    await stalledAt('implement');
    await after(60 * MINUTE);

    expect(await lines()).toEqual([
      'Stalled for 15 min with no reason; resumed (try 1 of 3)',
      'Stalled for 30 min with no reason; resumed (try 2 of 3)',
      'Stalled for 60 min with no reason; resumed (try 3 of 3)',
    ]);

    await stalledAt('implement');
    await after(15 * MINUTE);

    expect(await tries()).toHaveLength(3);
    expect(await reasonOf()).toEqual({
      code: 'STALLED',
      message: 'Stalled 4 times with no reason; Resume to try again',
    });
    expect(await find()).toMatchObject({ status: 'waiting', state: 'waiting' });
    expect(actionsFor('waiting', 'STALLED')).toContain('resume');
    await after(2 * HOUR);
    expect(await tries()).toHaveLength(3);
  });

  it('counts a new visit of the same step toward the three tries', async () => {
    for (const wait of [15, 30, 60]) {
      await stalledAt('checks');
      await after(wait * MINUTE);
    }
    await stalledAt('checks');
    await after(15 * MINUTE);

    expect((await tries()).map((command) => JSON.parse(command.payload))).toEqual(
      Array(3).fill({ stalledAt: 'checks' }),
    );
    expect(await reasonOf()).toMatchObject({ code: 'STALLED' });
  });

  it('gets six resumes in all when it stalls after every step, then STALLED', async () => {
    for (let step = 1; step <= 6; step += 1) {
      await stalledAt(`step-${step}`);
      await after(15 * MINUTE);
    }
    expect(await tries()).toHaveLength(6);
    expect(await lines()).toHaveLength(6);

    await stalledAt('step-7');
    await after(15 * MINUTE);

    expect(await tries()).toHaveLength(6);
    expect(await reasonOf()).toEqual({
      code: 'STALLED',
      message: 'Stalled 7 times; the server stopped resuming it',
    });
  });

  it("starts both counts again on a person's Resume", async () => {
    for (const wait of [15, 30, 60]) {
      await stalledAt('implement');
      await after(wait * MINUTE);
    }
    await personResumes();

    await stalledAt('implement');
    await after(15 * MINUTE);

    expect(await tries()).toHaveLength(4);
    expect(await lines()).toHaveLength(4);
    expect((await lines())[3]).toBe('Stalled for 15 min with no reason; resumed (try 1 of 3)');
  });

  it('does not start the counts again on a Resume the server sends itself', async () => {
    for (const wait of [15, 30, 60]) {
      await stalledAt('implement');
      await after(wait * MINUTE);
    }
    await app.app.get(CommandService).accept('resume', KEY, {});
    await app.app.get(CommandService).idle();

    await stalledAt('implement');
    await after(15 * MINUTE);

    expect(await tries()).toHaveLength(3);
    expect(await reasonOf()).toMatchObject({ code: 'STALLED' });
  });

  it('is left alone while a command of it is pending', async () => {
    app.app
      .get(CommandService)
      .register('resume', () => new Promise((resolve) => holds.push(() => resolve(undefined))));
    await stalledAt('implement');
    await app.app.get(CommandService).accept('resume', KEY, {}, { idempotencyKey: 'person-held' });

    app.clock.advance(HOUR);
    await app.app.get(Reconciler).resumeStalled();

    expect(await tries()).toHaveLength(0);
    expect(await reasonOf()).toBeNull();
  });

  it('is not resumed after 24 hours: it goes to a person at once', async () => {
    await stalledAt('implement');

    await after(25 * HOUR);

    expect(await tries()).toHaveLength(0);
    expect(await reasonOf()).toEqual({
      code: 'STALLED',
      message: 'Stalled for over 24 hours with no reason; Resume to try again',
    });
  });

  it('sends no try while the server is paused, and the due try goes out after the pause', async () => {
    await stalledAt('implement');
    app.app.get(ContainerGate).pause();

    await after(HOUR);
    expect(await tries()).toHaveLength(0);

    app.app.get(ContainerGate).resume();
    await after(0);
    expect(await tries()).toHaveLength(1);
  });

  it('is left alone while a step of this process holds it', async () => {
    await stalledAt('implement');
    await app.app.get(Reconciler).start((key) => key === KEY);

    await after(HOUR);

    expect(await tries()).toHaveLength(0);
  });

  it.each([
    ['answers', { status: 'waiting', facts: { needsAnswers: true } }],
    ['a subtask', { status: 'waiting', reason: { code: ERROR_CODES.SUBTASK_WAITING, message: 'subtask' } }],
    ['a limit', { status: 'waiting', reason: { code: ERROR_CODES.RUNTIME_LIMIT, message: 'limit' } }],
    ['a host', { status: 'waiting', reason: { code: ERROR_CODES.HOST_UNAVAILABLE, message: 'host' } }],
    ['CI', { status: 'waiting', reason: { code: ERROR_CODES.CI_NOT_STARTED, message: 'ci' } }],
    ['a stop', { status: 'blocked', reason: { code: 'STOPPED', message: 'stopped' } }],
  ])('is never resumed by this when it waits for %s', async (_name, change) => {
    await stalledAt('implement');
    const run = await find();
    writeRunState(run, change);
    await app.app.get(RunRepository).saveRun(run);

    await after(2 * HOUR);

    expect(await tries()).toHaveLength(0);
    expect((await find()).status).toBe(change.status);
  });

  it('is never resumed by this when the run view shows open questions that no reason is stored for', async () => {
    await stalledAt('plan');
    await app.app.get(DocumentRepository).putDocument(await find(), 'questions', '- which database?\n');

    await after(2 * HOUR);

    expect(await tries()).toHaveLength(0);
    expect(await reasonOf()).toBeNull();
  });

  it('gets one try only when the server restarts after the try was stored', async () => {
    await stalledAt('implement');
    await after(15 * MINUTE);
    const before = app.clock.now();

    app = await app.restart();
    app.clock.advance(before - app.clock.now());
    app.app.get(CommandService).register('resume', () => Promise.resolve(undefined));
    await app.app.get(Reconciler).resumeStalled();
    await app.app.get(CommandService).idle();

    expect(await tries()).toHaveLength(1);
    expect((await tries())[0].idempotencyKey).toMatch(/^stall-PROJ-87\d+-attempt-\d+-1$/);
  });

  it('is found by reconcileAll', async () => {
    await stalledAt('implement');
    app.clock.advance(15 * MINUTE);

    await app.app.get(Reconciler).reconcileAll();
    await app.app.get(CommandService).idle();

    expect(await tries()).toHaveLength(1);
  });
});
