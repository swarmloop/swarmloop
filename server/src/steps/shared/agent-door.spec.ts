import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { seededBoot } from '../../api/runs-boot.spec-helpers';
import { RunStop } from '../../agent/run-stop';
import { StepStopped } from '../../agent/step-stopped';
import { ERROR_CODES } from '../../contract/error-codes';
import { REASON } from '../../contract/run-state';
import { ARTIFACTS } from '../contract/artifacts';
import { AgentExchangeEntity, DocumentEntity, StepStatEntity } from '../../history/entities';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { writeRunState } from '../../history/run-state';
import { VisitRepository } from '../../history/visit.repository';
import { VisitStartRepository } from '../../history/visit-start.repository';
import { doorAround } from '../../testing/agent-door.spec-helpers';
import { save } from '../../testing/runs.spec-helpers';
import type { OpenedStep } from '../step-run';
import type { AgentDoor, OutsideStart } from './agent-door';
import type { AgentLaunchRequest } from './agent-launch-request';
import type { LaunchResult } from './result-exchange';
import { refusedRoute, StartRefused, WRITE_REFUSAL } from './start-refused';
import { storeRun } from '../../testing/store-run.spec-helpers';

async function setup(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'swarmloop-agent-door-'));
  const app = await seededBoot(dir, undefined, undefined, env);
  const runs = app.get(RunRepository);
  const run = await save(runs, 'proj-1', 'implement', 'waiting');
  const launched: AgentLaunchRequest[] = [];
  const events: string[] = [];
  const door: AgentDoor = doorAround(app, {
    launch: async (request) => {
      launched.push(request);
      events.push('launch');
      return {} as LaunchResult;
    },
  });
  const request = (tools: AgentLaunchRequest['tools'] = 'read', spentUsd = 0): AgentLaunchRequest =>
    ({ key: run.key, step: 'plan', tools, run: { id: run.id, spentUsd, agentCalls: 0, activeAttempt: null } }) as never;
  const start = (by: OutsideStart['by'], texts: string[] = ['same']): OutsideStart => ({
    step: 'plan',
    by,
    plannerLevel: 0,
    input: { texts },
  });
  /** The visit an earlier start stored: its exchange holds the last words, and the start row links it. */
  const store = async (startId: string, words: string, status = 'done', errors: string[] = []) => {
    const now = new Date().toISOString();
    const stat = Object.assign(new StepStatEntity(), {
      runId: run.id,
      step: 'plan',
      attempt: 1,
      attemptId: 'attempt-1',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      status,
    });
    await app.get(VisitRepository).saveStat(stat);
    if (errors.length > 0) {
      await app
        .get(DataSource)
        .getRepository(DocumentEntity)
        .insert({
          runId: run.id,
          stepStatId: stat.id,
          kind: ARTIFACTS.answerErrors.kind,
          attempt: 1,
          body: ARTIFACTS.answerErrors.format(errors),
          path: 'answer-errors.md',
          createdAt: now,
        });
    }
    await app.get(DataSource).getRepository(AgentExchangeEntity).insert({
      stepStatId: stat.id,
      model: 'm',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      requestText: 'ask',
      responseText: words,
    });
    await door.linkVisit(startId, stat.id);
  };
  const rows = () => app.get(VisitStartRepository).forRun(run.id);
  return { app, run, runs, door, launched, events, request, start, store, rows };
}

describe('AgentDoor', () => {
  it('refuses write tools to a start that is no step visit, with its reason, and launches nothing', async () => {
    const { app, door, launched, request, start, rows } = await setup();
    try {
      const refused = await door.outside(start('machine'), request('write')).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(StartRefused);
      expect((refused as StartRefused).kind).toBe('write');
      expect((refused as StartRefused).message).toBe(WRITE_REFUSAL);
      expect(launched).toEqual([]);
      expect(await rows()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('lets implement start with write tools in its visit and records the start', async () => {
    const { app, door, launched, request, rows } = await setup();
    try {
      const opened = { attemptId: 'attempt-1' } as OpenedStep;

      await door.inVisit({ opened, step: 'implement', options: { startBy: 'machine' } }, request('write'));

      expect(launched.map((sent) => sent.tools)).toEqual(['write']);
      expect(await rows()).toMatchObject([{ step: 'implement', attemptId: 'attempt-1', outside: false }]);
    } finally {
      await app.close();
    }
  });

  it('refuses an outside start on the input of a finished linked visit, one level above the planner, and keeps the refusal', async () => {
    const { app, door, launched, request, start, store, rows } = await setup();
    try {
      let startId = '';
      await door.outside({ ...start('machine'), admitted: (id) => void (startId = id) }, request());
      await store(startId, 'Which retry policy?');

      const refused = await door.outside(start('machine'), request()).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(StartRefused);
      const error = refused as StartRefused;
      expect(error.kind).toBe('same-input');
      expect(error.reasonCode).toBe(REASON.sameInput);
      expect(error.startLevel).toBe(1);
      expect(error.question?.text).toContain('Which retry policy?');
      expect(refusedRoute(error)).toEqual({ to: 'wait', code: REASON.sameInput, reason: error.message });
      expect(door.takeRefusal('proj-1')).toMatchObject({ startLevel: 1, question: { from: 'plan' } });
      expect(door.takeRefusal('proj-1')).toBeNull();
      expect(launched).toHaveLength(1);
      expect(await rows()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('refuses an outside start after a visit whose answer stayed invalid, with its errors in the question', async () => {
    const { app, door, launched, request, start, store } = await setup();
    try {
      let startId = '';
      await door.outside({ ...start('machine'), admitted: (id) => void (startId = id) }, request());
      await store(startId, 'last words', 'failed', ['keep line names unknown task']);

      const refused = await door.outside(start('machine'), request()).catch((error: unknown) => error);

      expect((refused as StartRefused).kind).toBe('same-input');
      expect((refused as StartRefused).question?.text).toContain(
        'The answer was refused for:\n- keep line names unknown task',
      );
      expect(launched).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("goes on with a person's outside start on the same input", async () => {
    const { app, door, launched, request, start, store } = await setup();
    try {
      let startId = '';
      await door.outside({ ...start('machine'), admitted: (id) => void (startId = id) }, request());
      await store(startId, 'words');

      await door.outside(start('person'), request());

      expect(launched).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('refuses an outside start when the limit is reached on the launch run while a step holds the run', async () => {
    const { app, run, runs, door, launched, request, start } = await setup({ MAX_RUN_USD: '25' });
    try {
      writeRunState(run, { status: 'running', currentStep: 'implement' });
      await storeRun(runs, run);

      const refused = await door.outside(start('machine'), request('read', 30)).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(StartRefused);
      expect((refused as StartRefused).kind).toBe('limit');
      expect((refused as StartRefused).reasonCode).toBe(ERROR_CODES.SPEND_LIMIT);
      expect(refusedRoute(refused as StartRefused)).toMatchObject({ to: 'block', code: ERROR_CODES.SPEND_LIMIT });
      expect(launched).toEqual([]);
      expect(await app.get(DocumentRepository).latestBody(run.key, 'spend')).toContain('over the spend limit');
    } finally {
      await app.close();
    }
  });

  it('refuses any start of a halted run with StepStopped', async () => {
    const { app, door, launched, request, start } = await setup();
    try {
      app.get(RunStop).halt('proj-1');

      await expect(door.outside(start('person'), request())).rejects.toBeInstanceOf(StepStopped);
      await expect(
        door.inVisit({ opened: { attemptId: 'attempt-9' } as OpenedStep, step: 'plan', options: {} }, request()),
      ).rejects.toBeInstanceOf(StepStopped);
      expect(launched).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('gives admitted the start id, which names the stored row, before the launch', async () => {
    const { app, door, events, request, start, rows } = await setup();
    try {
      let startId = '';
      await door.outside(
        {
          ...start('machine'),
          admitted: (id) => {
            startId = id;
            events.push('admitted');
          },
        },
        request(),
      );

      expect(events).toEqual(['admitted', 'launch']);
      expect(await rows()).toMatchObject([{ attemptId: startId, outside: true, step: 'plan' }]);
    } finally {
      await app.close();
    }
  });
});
