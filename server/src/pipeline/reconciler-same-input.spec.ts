import 'reflect-metadata';
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
import { StartGate } from './start-gate';
import { SubtaskPort } from './subtask-port';

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
  await runs.saveRun(run);
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
  await runs.saveRun(run);
  return { app, run, steps };
}

describe('a SAME_INPUT wait that a restart left', () => {
  it('is resumed once, keyed by its open question, and the question is asked again at the same level', async () => {
    const { app, run, steps } = await refusedRun();
    try {
      const asks = jest
        .spyOn(app.app.get(SubtaskPort), 'askUp')
        .mockResolvedValue({ asked: 'starter', level: 1, answer: null });
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
      expect(asks).toHaveBeenCalledTimes(1);
      expect(asks.mock.calls[0][1].text).toContain('Not started again: same input as visit 1');
      expect(asks.mock.calls[0][2]).toBe(0);
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
