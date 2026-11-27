import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { AppConfig } from '../config/env';
import { parseSubtasks } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { readPlan } from '../steps/plan/plan-record';
import { shippedDefaults } from '../config/env.schema.spec-helpers';
import { OUTSIDE_APP_CONFIG, SplitPlanAgent, expectedEnv } from './defaults-flow.spec-helpers';
import { createTestApp, type TestApp } from './test-app';

const KEY = 'PROJ-500';

describe('the defaults the server ships, in a whole flow that sets nothing', () => {
  let app: TestApp;
  let agent: SplitPlanAgent;

  beforeAll(async () => {
    agent = new SplitPlanAgent();
    app = await createTestApp({ envFile: false, realSteps: ['plan', 'plan-improve'], runner: agent });
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs with every shipped setting, apart from the isolation of the app', () => {
    const { env } = app.app.get(AppConfig);
    const isolation = {
      SWARMLOOP_ROOT: app.root,
      SWARMLOOP_API_PORT: 0,
      SWARMLOOP_TOKEN: app.auth.authorization.slice(7),
    };
    expect(env).toEqual(expectedEnv(isolation));
    expect(env).toMatchObject({
      REQUIREMENTS_VIA: 'agent',
      SPLIT: 'auto',
      EPIC_EFFORT: 'high',
      CHECKS_PARALLEL: 3,
      MIN_FREE_GB: 10,
    });
  });

  it('names every setting of defaults.env that AppConfig does not carry', () => {
    const { env } = app.app.get(AppConfig);
    const missing = Object.keys(shippedDefaults()).filter((key) => !(key in env));
    expect(missing.sort()).toEqual([...OUTSIDE_APP_CONFIG].sort());
  });

  it('plans a split, plans no second time at the shipped epic effort, and goes on past plan-improve', async () => {
    const runs = app.app.get(RunRepository);
    const documents = app.app.get(DocumentRepository);
    const run = await runs.openSplit(KEY);
    mkdirSync(join(app.root, 'worktrees', KEY, 'billing-api'), { recursive: true });
    run.currentStep = 'plan';
    await storeRun(runs, run);
    await documents.putDocument(run, 'requirements', '{"prompt":"ship the field"}\n');
    await documents.putDocument(run, 'repos', 'billing-api\n');

    await app.pipeline.runThrough(KEY, { auto: true });

    expect(agent.launches.map((launch) => launch.step)).toEqual(['plan', 'plan-improve']);
    expect(agent.launches.map((launch) => launch.effort)).toEqual(['high', 'high']);
    const stored = (await runs.findRun(KEY))!;
    expect(stored.split).toBe(true);
    expect(stored.epicAt).toBeTruthy();
    const tasks = parseSubtasks(await documents.latestBody(KEY, 'subtasks'));
    expect(tasks.map((task) => [task.id, task.depends])).toEqual([
      ['column', []],
      ['api', ['column']],
      ['ui', ['api']],
    ]);
    expect(readPlan((await documents.latestBody(KEY, 'requirements')) ?? '')?.decision).toBe('approve');
    const visited = (await app.app.get(VisitRepository).listStats(stored.id)).map((visit) => visit.step);
    expect(visited.slice(0, 3)).toEqual(['plan', 'plan-improve', 'branch']);
  });
});
