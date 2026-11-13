import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AGENT_RUNNER } from '../agent/agent-runner';
import { STEPS, type StepName } from '../contract/steps';
import { CommandEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { StepKernel } from '../steps/step-kernel';
import { StepRegistry } from '../steps/step.registry';
import type { Step } from '../steps/step';
import { ScriptedStep } from '../testing/test-app';

// A repo-root `.env` must not leak into the boot.
jest.mock('../config/load-env', () => ({ loadEnvFile: jest.fn(), assertEnvFile: jest.fn() }));

const KEY = 'PROJ-620';
const SETTINGS = {
  REQUIREMENTS_VIA: 'direct',
  ISSUE_TRACKER: 'jira',
  JIRA_BASE_URL: '',
  JIRA_EMAIL: '',
  JIRA_API_TOKEN: '',
  GITLAB_BASE_URL: '',
  GITLAB_TOKEN: '',
  GITHUB_BASE_URL: '',
  GITHUB_TOKEN: '',
  CURSOR_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  IDLE_TIMEOUT_MS: '900000',
  TICK_MS: '15000',
  REQUIREMENTS_TIMEOUT_MS: '600000',
  RESEARCH_TIMEOUT_MS: '900000',
  PLAN_TIMEOUT_MS: '1200000',
  IMPLEMENT_TIMEOUT_MS: '1800000',
  CODE_REVIEW_TIMEOUT_MS: '900000',
  MERGE_REQUEST_TIMEOUT_MS: '600000',
  PIPELINE_TIMEOUT_MS: '1800000',
  PIPELINE_START_TIMEOUT_MS: '180000',
  MAX_AGENT_CALLS: '20',
  MAX_RETURNS: '3',
  MAX_LAUNCHES: '3',
  MAX_RUN_USD: '25',
  AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
  AGENTS_IMPLEMENT: 'cursor:grok-4.7',
  AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
  SWARMLOOP_API_PORT: '0',
  SWARMLOOP_API_HOST: '127.0.0.1',
  SWARMLOOP_TOKEN: 'boot-token',
};

describe('the API server boot', () => {
  const saved = { ...process.env };
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-api-boot-'));
    Object.assign(process.env, SETTINGS, { SWARMLOOP_ROOT: root });
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(root, { recursive: true, force: true });
  });

  it('relaunches a step that a dead instance left running, once every command handler is registered', async () => {
    const { ApiModule } = await import('./api.module');
    const steps = new Map<StepName, Step>();
    const registry = { get: (name: StepName) => steps.get(name) ?? null, describe: () => [] };
    const module = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(AGENT_RUNNER)
      .useValue({ run: () => Promise.resolve() })
      .overrideProvider(SandboxService)
      .useValue({
        assertReady: () => Promise.resolve(),
        kill: () => Promise.resolve(),
        attemptRunning: () => Promise.resolve(false),
        killAttempt: () => Promise.resolve(true),
      })
      .overrideProvider(StepRegistry)
      .useValue(registry)
      .compile();
    for (const name of STEPS) {
      if (name === 'done') continue;
      steps.set(
        name,
        new ScriptedStep(name, module.get(StepKernel), module.get(AGENT_RUNNER), {
          open: () => Promise.resolve({ url: '' }),
        }),
      );
    }
    const app = module.createNestApplication();
    try {
      const runs = module.get(RunRepository);
      const run = await runs.begin(KEY, 'research');
      const attempt = run.activeAttempt;
      writeRunState(run, { status: 'running', ownerInstance: 'dead-instance', ownerPid: 2_147_483_646 });
      await runs.saveRun(run);

      await app.init();
      await module.get(CommandService).idle();
      await module.get(PipelineService).whenIdle(KEY);

      const command = await module
        .get(DataSource)
        .getRepository(CommandEntity)
        .findOneBy({ idempotencyKey: `relaunch-${attempt}` });
      expect(command?.state).toBe('succeeded');
      expect((await runs.findRun(KEY))?.activeAttempt).not.toBe(attempt);
    } finally {
      await app.close();
    }
  }, 30_000);
});
