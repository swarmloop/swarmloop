import 'reflect-metadata';
import { storeRun } from '../testing/store-run.spec-helpers';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REASON } from '../contract/run-state';
import type { StepName } from '../contract/steps';
import { CommandRepository } from '../history/command.repository';
import { StepStatEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { VisitStartRepository } from '../history/visit-start.repository';
import { StepRegistry } from '../steps/step.registry';
import type { Step } from '../steps/step';
import { save } from '../testing/runs.spec-helpers';
import { createTestApp } from '../testing/test-app';
import { CommandService } from './command.service';
import { Reconciler } from './reconciler';
import { installScripts } from './run-driver.spec-helpers';
import { ERROR_CODES } from '../contract/error-codes';
import { refusalQuestion, sameInput } from '../steps/shared/same-input';
import { StartGate } from './start-gate';

const KEY = 'PROJ-81';
const ASKED = {
  key: 'up-0a1b2c3d4e',
  role: 'planner' as const,
  kind: 'question' as const,
  from: 'implement',
  text: 'Not started again: same input as visit 1; asked the person who started the run.',
  at: '2026-01-01T00:00:00.000Z',
  state: 'pending' as const,
};

/** A run that waits SAME_INPUT on an agent step: its last visit ended on the input the step would start on again. */
async function refusedRun() {
  const app = await createTestApp();
  const steps = installScripts(app, {}, ['implement']);
  const registry = app.app.get<{ get(name: StepName): Step | null }>(StepRegistry);
  const scripted = registry.get('implement');
  registry.get = (name) =>
    name === 'implement' ? (Object.create(scripted, { usesModel: { value: true } }) as Step) : null;
  const runs = app.app.get(RunRepository);
  const run = await save(runs, KEY, 'implement', 'waiting');
  run.targetPath = mkdtempSync(join(tmpdir(), 'swarmloop-same-input-'));
  await storeRun(runs, run);
  await app.app
    .get(DocumentRepository)
    .putDocument(run, 'requirements', `${JSON.stringify({ prompt: 'p', tickets: [] })}\n`);
  const seen = await app.app.get(StartGate).admit(KEY, 'implement', {});
  if (seen.kind !== 'admitted') throw new Error('the first start was refused');
  const now = new Date().toISOString();
  await app.app.get(VisitStartRepository).note({
    runId: run.id,
    step: 'implement',
    attemptId: 'attempt-1',
    startedBy: 'person',
    level: null,
    inputDigest: seen.start.digest,
    startReason: null,
    rerunUnfinished: false,
    createdAt: now,
  });
  await app.app.get(VisitRepository).saveStat(
    Object.assign(new StepStatEntity(), {
      runId: run.id,
      step: 'implement',
      attempt: 1,
      attemptId: 'attempt-1',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      status: 'waiting',
    }),
  );
  writeRunState(run, {
    status: 'waiting',
    reason: {
      code: REASON.sameInput,
      message: 'Not started again: same input as visit 1; asked the planner of this run',
    },
  });
  await storeRun(runs, run);
  return { app, run, steps };
}

describe('a SAME_INPUT wait that a restart left', () => {
  it('is resumed once, keyed by its open question, and the question is asked again at the same level', async () => {
    const { app, run, steps } = await refusedRun();
    try {
      await app.app.get(PlanChatStore).appendEntry(KEY, ASKED);

      await app.app.get(Reconciler).resumeSameInput();
      await app.app.get(Reconciler).resumeSameInput();
      await app.app.get(CommandService).idle();
      await app.pipeline.whenIdle(KEY);

      const resumes = (await app.app.get(CommandRepository).listForRun(run.id)).filter(
        (command) => command.type === 'resume',
      );
      expect(resumes.map((command) => command.idempotencyKey)).toEqual([`same-input-${ASKED.key}`]);
      expect(JSON.parse(resumes[0].payload)).toEqual({ by: 'machine', level: null });
      const { entries } = await app.app.get(PlanChatStore).read(KEY);
      const refusal = entries.filter((entry) => entry.text.includes('Not started again: same input as visit 1'));
      // The question the chain put to the run's own planner (level 0) once, besides the one seeded above, and the one put to the starter once.
      expect(refusal.filter((entry) => entry.kind === 'question' && entry.key !== ASKED.key)).toHaveLength(1);
      expect(refusal.filter((entry) => entry.kind === 'escalation')).toHaveLength(1);
      expect(steps.get('implement')?.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('is left alone when no question of the chain is open, and when a process holds the run', async () => {
    const { app, run } = await refusedRun();
    try {
      await app.app.get(Reconciler).resumeSameInput();
      expect(await app.app.get(CommandRepository).listForRun(run.id)).toEqual([]);

      await app.app.get(PlanChatStore).appendEntry(KEY, ASKED);
      await app.app.get(Reconciler).start(() => true);
      await app.app.get(Reconciler).resumeSameInput();

      expect(await app.app.get(CommandRepository).listForRun(run.id)).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe('sameInput', () => {
  const finished: {
    id: number;
    step: string;
    attempt: number;
    attemptId: string;
    status: string;
    killReason: string | null;
  } = {
    id: 1,
    step: 'implement',
    attempt: 1,
    attemptId: 'a1',
    status: 'waiting',
    killReason: null,
  };
  const facts = (reasonCode: string | null, digest = 'd') => ({
    step: 'implement',
    digest,
    stats: [finished],
    starts: [{ step: 'implement', attemptId: 'a1', inputDigest: 'd' }],
    reasonCode,
  });

  it.each(['SUBTASK_WAITING', 'SUBTASKS_RUNNING', 'SAME_INPUT'])(
    'is the same input for a finished visit while the run waits with %s',
    (code) => {
      expect(sameInput(facts(code))).toEqual({ kind: 'same', visit: 1, statId: 1 });
      expect(sameInput(facts(code, 'other'))).toEqual({ kind: 'new', rerunUnfinished: false });
    },
  );

  it.each(['HOST_UNAVAILABLE', 'RUNTIME_LIMIT'])(
    'reruns the visit while the run waits for an outage or limit: %s',
    (code) => {
      expect(sameInput(facts(code))).toEqual({ kind: 'new', rerunUnfinished: true });
    },
  );

  describe('the end of the last visit, on the same input', () => {
    const ended = (stat: Partial<typeof finished> & { answerErrors?: string[] }) => ({
      step: 'implement',
      digest: 'd',
      stats: [{ ...finished, ...stat }],
      starts: [{ step: 'implement', attemptId: 'a1', inputDigest: 'd' }],
      reasonCode: null,
    });
    const rerun = { kind: 'new', rerunUnfinished: true };

    it('is the same input after an answer that stayed invalid or the agent’s own limit', () => {
      const same = { kind: 'same', visit: 1, statId: 1 };
      expect(sameInput(ended({ status: 'failed', answerErrors: ['keep line unknown'] }))).toEqual(same);
      expect(sameInput(ended({ status: 'interrupted', killReason: 'process killed: calls' }))).toEqual(same);
      expect(sameInput(ended({ status: 'interrupted', killReason: 'process killed: time' }))).toEqual(same);
    });

    it.each([
      ['a model host outage', { status: 'interrupted', killReason: ERROR_CODES.HOST_UNAVAILABLE }],
      ['a usage limit', { status: 'interrupted', killReason: ERROR_CODES.RUNTIME_LIMIT }],
      ['a failure with no answer errors and no kill', { status: 'failed' }],
    ])('reruns after %s', (_name, stat) => {
      expect(sameInput(ended(stat))).toEqual(rerun);
    });

    it('reruns a start with no stored visit and goes on with a new digest', () => {
      expect(sameInput({ ...ended({}), stats: [] })).toEqual(rerun);
      expect(sameInput({ ...ended({ status: 'failed', answerErrors: ['x'] }), digest: 'other' })).toEqual({
        kind: 'new',
        rerunUnfinished: false,
      });
    });

    it('puts the answer errors in the refusal question only when there are some', () => {
      expect(refusalQuestion('plan', 2, 'words').text).not.toContain('refused for');
      expect(refusalQuestion('plan', 2, 'words', ['bad one', 'bad two']).text).toMatch(
        /words\n\nThe answer was refused for:\n- bad one\n- bad two$/,
      );
    });
  });
});
