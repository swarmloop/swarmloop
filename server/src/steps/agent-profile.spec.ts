import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../config/env';
import type { SwarmloopEnv } from '../config/env';
import { CODE_REVIEWERS } from '../contract/steps';
import { boot } from './prepare/prepare.step.spec-helpers';
import { StepRegistry } from './step.registry';

const MODELS = { MODEL_PLAN: 'plan-model', MODEL_IMPLEMENT: 'implement-model' };

describe('agent profiles', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;
  let env: SwarmloopEnv;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-profile-'));
    app = await boot(root);
    env = { ...app.get(AppConfig).env, ...MODELS };
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('gives every agent step the model, mode and time limit it runs with, and no other step a profile', () => {
    const described = app.get(StepRegistry).describe(env);
    const profile = (name: string) => described.find((item) => item.name === name)?.agent;
    expect(profile('research')).toEqual({
      runtime: 'cursor',
      model: MODELS.MODEL_PLAN,
      mode: 'plan',
      tools: 'plan',
      timeLimitMs: env.RESEARCH_TIMEOUT_MS,
      session: 'resume',
    });
    for (const name of ['plan', 'plan-improve']) {
      expect(profile(name)).toMatchObject({
        model: MODELS.MODEL_PLAN,
        mode: 'plan',
        tools: 'plan',
        timeLimitMs: env.PLAN_TIMEOUT_MS,
      });
    }
    for (const name of ['implement', 'implement-improve']) {
      expect(profile(name)).toMatchObject({
        runtime: 'cursor',
        model: MODELS.MODEL_IMPLEMENT,
        mode: 'agent',
        tools: 'write',
        timeLimitMs: env.IMPLEMENT_TIMEOUT_MS,
      });
    }
    expect(profile('code-review')).toMatchObject({
      model: MODELS.MODEL_PLAN,
      mode: 'ask',
      tools: 'read',
      timeLimitMs: env.CODE_REVIEW_TIMEOUT_MS,
    });
    for (const item of described) {
      expect(item.agent !== undefined).toBe(item.kind === 'agent');
    }
  });

  it('gives only research, plan and plan-improve the plan tools', () => {
    const described = app.get(StepRegistry).describe(env);
    const names = described.filter((item) => item.agent?.tools === 'plan').map((item) => item.name);
    expect(names.sort()).toEqual(['plan', 'plan-improve', 'research']);
  });

  it('lists one reviewer per angle of the code review, with its model and mode', () => {
    const review = app
      .get(StepRegistry)
      .describe(env)
      .find((item) => item.name === 'code-review');
    expect(review?.reviewers).toEqual(CODE_REVIEWERS.map((name) => ({ name, model: MODELS.MODEL_PLAN, mode: 'ask' })));
  });
});
