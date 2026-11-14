import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
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

const KEY = 'PROJ-620';
const SETTINGS = {
  REQUIREMENTS_VIA: 'direct',
  SWARMLOOP_TOKEN: 'boot-token',
};

describe('the API server boot', () => {
  const saved = { ...process.env };
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(__dirname, '.api-boot-'));
    process.env = { ...SETTINGS, SWARMLOOP_ROOT: root, CHECKOUTS_ROOT: root, SWARMLOOP_ENV_FILE: join(root, '.env') };
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
    const app = module.createNestApplication();
    try {
      for (const name of STEPS) {
        if (name === 'done') continue;
        steps.set(
          name,
          new ScriptedStep(name, module.get(StepKernel), module.get(AGENT_RUNNER), {
            open: () => Promise.resolve({ url: '' }),
          }),
        );
      }
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
