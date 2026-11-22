import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { seededBoot } from '../api/runs-boot.spec-helpers';
import { REASON } from '../contract/run-state';
import { CommandRepository } from '../history/command.repository';
import { DataSource } from 'typeorm';
import { AgentExchangeEntity, StepStatEntity } from '../history/entities';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { VisitStartRepository } from '../history/visit-start.repository';
import type { StepOptions } from '../core/pipeline-result';
import { storedState, writeRunState } from '../history/run-state';
import { save } from '../testing/runs.spec-helpers';
import { CommandService } from './command.service';
import { PERSON_RESUME, startByOf } from './resume-sender';
import { StartGate } from './start-gate';

async function setup() {
  const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-start-gate-')));
  const runs = app.get(RunRepository);
  app.get(CommandService).register('resume', async () => ({ key: 'proj-1', status: 'started' }));
  const run = await save(runs, 'proj-1', 'implement', 'waiting');
  const stop = async () => {
    writeRunState(run, { status: 'blocked', reason: { code: REASON.stopped, message: 'Stopped.' } });
    await runs.saveRun(run);
  };
  const stored = async () => (await app.get(CommandRepository).listForRun(run.id)).filter((c) => c.type === 'resume');
  return { app, gate: app.get(StartGate), run, stop, stored };
}

describe('StartGate', () => {
  it('resumes a run that waits, and answers replayed for the same event', async () => {
    const { app, gate, run, stored } = await setup();
    try {
      expect(await gate.resume(run, { by: 'machine', event: 'limit-1' })).toBe('accepted');
      expect(await gate.resume(run, { by: 'machine', event: 'limit-1' })).toBe('replayed');
      expect(await stored()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('stores who asks, with the level of a planner, in the payload', async () => {
    const { app, gate, run, stored } = await setup();
    try {
      await gate.resume(run, { by: 'machine', event: 'a' });
      await gate.resume(run, { by: 'planner', level: 2, event: 'b', payload: { stalledAt: 'x' } });

      const payloads = (await stored()).map((command) => JSON.parse(command.payload));
      expect(payloads).toEqual([
        { by: 'machine', level: null },
        { by: 'planner', level: 2, stalledAt: 'x' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('does not resume a run a person stopped for the machine or a planner, and stores no command', async () => {
    const { app, gate, run, stop, stored } = await setup();
    try {
      await stop();

      expect(await gate.stopped(run)).toBe(true);
      expect(await gate.resume(run, { by: 'machine', event: 'a' })).toBe('stopped');
      expect(await gate.resume(run, { by: 'planner', level: 1, event: 'b' })).toBe('stopped');
      expect(await stored()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("resumes a stopped run for a person and for a planner on a person's message", async () => {
    const { app, gate, run, stop, stored } = await setup();
    try {
      await stop();

      expect(await gate.resume(run, { by: 'person', event: 'a' })).toBe('accepted');
      expect(await gate.resume(run, { by: 'planner', level: 0, event: 'b', payload: { ...PERSON_RESUME } })).toBe(
        'accepted',
      );

      const payloads = (await stored()).map((command) => JSON.parse(command.payload));
      expect(payloads).toEqual([
        { by: 'person', level: null },
        { by: 'person', level: 0 },
      ]);
    } finally {
      await app.close();
    }
  });
});

/** A run at implement whose worktree folder is its target, so the input the gate reads is the same on every read. */
async function admitting(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'swarmloop-admit-'));
  const app = await seededBoot(dir, undefined, undefined, env);
  const runs = app.get(RunRepository);
  const run = await save(runs, 'proj-1', 'implement', 'waiting');
  run.targetPath = dir;
  await runs.saveRun(run);
  const gate = app.get(StartGate);
  const digest = async (): Promise<string | null> => {
    const seen = await gate.admit(run.key, 'implement', {});
    return seen.kind === 'admitted' ? seen.start.digest : null;
  };
  /** A visit of the step as it was started and ended: `digest` is the input it had, a missing `ended` is a process that died. */
  const visit = async (
    attempt: number,
    last: { digest: string | null; ended?: Partial<StepStatEntity> | null; words?: string },
  ) => {
    const attemptId = `attempt-${attempt}`;
    await app.get(VisitStartRepository).note({
      runId: run.id,
      step: 'implement',
      attemptId,
      startedBy: 'machine',
      level: null,
      inputDigest: last.digest,
      startReason: null,
      rerunUnfinished: false,
      createdAt: 't',
    });
    if (last.ended === null) return;
    const now = new Date().toISOString();
    const stat = Object.assign(new StepStatEntity(), {
      runId: run.id,
      step: 'implement',
      attempt,
      attemptId,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      status: 'done',
      ...last.ended,
    });
    await app.get(VisitRepository).saveStat(stat);
    if (last.words !== undefined) {
      await app.get(DataSource).getRepository(AgentExchangeEntity).insert({
        stepStatId: stat.id,
        model: 'm',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        requestText: 'ask',
        responseText: last.words,
      });
    }
  };
  const admit = (options: StepOptions) => gate.admit(run.key, 'implement', options);
  const stored = async (): Promise<RunEntity> => (await runs.findRun(run.key))!;
  return { app, run, digest, visit, admit, stored, runs };
}

describe('StartGate admit', () => {
  it('refuses a start of the machine on the input of the last finished visit and stores the wait', async () => {
    const { app, digest, visit, admit, stored } = await admitting();
    try {
      await visit(1, { digest: await digest(), words: 'I need a decision on the retry policy.' });

      const seen = await admit({ startBy: 'machine' });

      expect(seen).toMatchObject({ kind: 'refused', startLevel: 0 });
      if (seen.kind !== 'refused') throw new Error('expected a refusal');
      expect(seen.message).toBe('Not started again: same input as visit 1; asked the planner of this run');
      expect(seen.question.from).toBe('implement');
      expect(seen.question.text).toBe(
        'Not started again: same input as visit 1; asked the person who started the run.\n\nI need a decision on the retry policy.',
      );
      expect(storedState(await stored())).toMatchObject({
        state: 'waiting',
        reason: { code: REASON.sameInput, message: seen.message },
      });
    } finally {
      await app.close();
    }
  });

  it('refuses a planner on the same input and asks one level above it', async () => {
    const { app, digest, visit, admit } = await admitting();
    try {
      await visit(1, { digest: await digest(), ended: { status: 'waiting' } });

      const seen = await admit({ startBy: 'planner', level: 0 });

      expect(seen).toMatchObject({
        kind: 'refused',
        startLevel: 1,
        message: "Not started again: same input as visit 1; asked the epic's planner",
      });
    } finally {
      await app.close();
    }
  });

  it('admits a new input, a person on the same input, and a visit with no recorded digest', async () => {
    const { app, digest, visit, admit } = await admitting();
    try {
      await visit(1, { digest: 'another-input' });
      expect(await admit({ startBy: 'machine' })).toMatchObject({
        kind: 'admitted',
        start: { rerunUnfinished: false },
      });

      await visit(2, { digest: await digest() });
      expect(await admit({})).toMatchObject({ kind: 'admitted', start: { agent: true } });
      expect(await admit({ startBy: 'person' })).toMatchObject({ kind: 'admitted' });
      expect((await admit({ startBy: 'machine' })).kind).toBe('refused');

      await visit(3, { digest: null });
      expect((await admit({ startBy: 'machine' })).kind).toBe('admitted');
    } finally {
      await app.close();
    }
  });

  it.each([
    ['killed', { ended: { status: 'killed', killReason: 'stop' } }],
    ['crashed', { ended: null }],
    ['failed', { ended: { status: 'failed' } }],
    ['cut by an outage', { ended: { status: 'interrupted', killReason: 'DOCKER_UNAVAILABLE' } }],
    ['cut by a limit', { ended: { status: 'interrupted', killReason: 'RUNTIME_LIMIT' } }],
  ])('admits a start again on the input of a visit that was %s and marks it', async (_name, ended) => {
    const { app, digest, visit, admit } = await admitting();
    try {
      await visit(1, { digest: await digest(), ...ended });

      expect(await admit({ startBy: 'machine' })).toMatchObject({
        kind: 'admitted',
        start: { agent: true, rerunUnfinished: true },
      });
    } finally {
      await app.close();
    }
  });

  it.each(['HOST_UNAVAILABLE', 'RUNTIME_LIMIT', 'SUBTASK_WAITING'])(
    'admits a machine start on the same input while the run waits with %s',
    async (code) => {
      const { app, digest, visit, admit, run, runs } = await admitting();
      try {
        await visit(1, { digest: await digest() });
        writeRunState(run, { status: 'waiting', reason: { code, message: 'later' } });
        await runs.saveRun(run);

        expect(await admit({ startBy: 'machine' })).toMatchObject({
          kind: 'admitted',
          start: { rerunUnfinished: true },
        });
      } finally {
        await app.close();
      }
    },
  );

  it('does not start a machine or planner start of a run a person stopped, and starts a person', async () => {
    const { app, run, runs, admit } = await admitting();
    try {
      writeRunState(run, { status: 'blocked', reason: { code: REASON.stopped, message: 'Stopped.' } });
      await runs.saveRun(run);

      expect((await admit({ startBy: 'machine' })).kind).toBe('blocked');
      expect((await admit({ startBy: 'planner', level: 0 })).kind).toBe('blocked');
      expect((await admit({})).kind).toBe('admitted');
    } finally {
      await app.close();
    }
  });

  it('lets only a run still recorded running on the step skip the limits', async () => {
    const { app, run, runs, admit } = await admitting({ MAX_RUN_USD: '25' });
    try {
      run.spentUsd = 30;
      await runs.saveRun(run);
      expect((await admit({})).kind).toBe('blocked');

      for (const status of ['failed', 'waiting']) {
        writeRunState(run, { status, currentStep: 'implement' });
        await runs.saveRun(run);
        expect((await admit({})).kind).toBe('blocked');
      }

      writeRunState(run, { status: 'running', currentStep: 'implement' });
      await runs.saveRun(run);
      expect((await admit({})).kind).toBe('admitted');

      writeRunState(run, { status: 'running', currentStep: 'plan' });
      await runs.saveRun(run);
      expect((await admit({})).kind).toBe('blocked');
    } finally {
      await app.close();
    }
  });
});

describe('startByOf', () => {
  const of = (payload: string) => startByOf({ payload });

  it('reads a person, a planner with its level, and the machine', () => {
    expect(of(JSON.stringify(PERSON_RESUME))).toEqual({ by: 'person', level: null });
    expect(of('{"by":"planner","level":3}')).toEqual({ by: 'planner', level: 3 });
    expect(of('{"by":"planner"}')).toEqual({ by: 'planner', level: null });
    expect(of('{}')).toEqual({ by: 'machine', level: null });
    expect(of('{"by":"robot"}')).toEqual({ by: 'machine', level: null });
    expect(of('not json')).toEqual({ by: 'machine', level: null });
  });
});
