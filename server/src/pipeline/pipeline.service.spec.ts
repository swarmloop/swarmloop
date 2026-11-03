import 'reflect-metadata';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../config/config.module';
import { HistoryService } from '../history/history.service';
import { AGENT_RUNNER } from '../agent/agent-runner';
import { SandboxService } from '../sandbox/sandbox.service';
import { CodeReviewStep } from '../steps/code-review/code-review.step';
import { withPlan } from '../steps/plan/plan-record';
import { PipelineModule } from './pipeline.module';
import { PipelineService } from './pipeline.service';

describe('pipeline service', () => {
  it('rejects a path on a step that does not take one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-path-'));
    const app = await boot(root);
    try {
      const result = await app.get(PipelineService).step('plan', 'PROJ-60', { path: root });
      expect(result).toEqual({ exitCode: 1, message: 'path is only valid for code-review' });
    } finally {
      await app.close();
    }
  });

  it('rejects a prompt on a step that does not take one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-prompt-'));
    const app = await boot(root);
    try {
      const result = await app.get(PipelineService).step('plan', 'PROJ-61', { prompt: 'Use the other parser' });
      expect(result).toEqual({ exitCode: 1, message: 'prompt is only valid for requirements' });
    } finally {
      await app.close();
    }
  });

  it('revises the stored requirements when instructions go to prepare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-revise-'));
    const app = await boot(root);
    try {
      const pipeline = app.get(PipelineService);
      const history = app.get(HistoryService);
      const seeded = await history.begin('PROJ-62', 'prepare');
      seeded.status = 'waiting';
      seeded.currentStep = 'prepare';
      await history.saveRun(seeded);
      await history.putDocument(
        seeded,
        'requirements',
        withPlan('{"prompt":"ship the field"}\n', { name: '', overview: '', items: ['add the field'], decision: null }),
      );
      await pipeline.replay('PROJ-62', 'prepare', 'Narrow the scope');
      const body = await history.latestBody('PROJ-62', 'requirements');
      expect((JSON.parse(body ?? '{}') as { plan: { decision: string } }).plan.decision).toBe('revise');
      await settle(pipeline, 'PROJ-62');
    } finally {
      await app.close();
    }
  });

  it('charges an abandoned code-review run through its step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipeline-abandon-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const seeded = await history.begin('PROJ-63', 'code-review');
      seeded.status = 'running';
      seeded.currentStep = 'code-review';
      await history.saveRun(seeded);
      const charge = jest.spyOn(app.get(CodeReviewStep), 'charge').mockResolvedValue(null);
      await app.get(PipelineService).onModuleInit();
      expect(charge).toHaveBeenCalledWith('PROJ-63', expect.anything(), expect.anything());
      expect((await history.findRun('PROJ-63'))?.status).toBe('failed');
    } finally {
      await app.close();
    }
  }, 30_000);
});

/** A started step runs in the background. Wait for it to release the key before the app closes. */
async function settle(pipeline: PipelineService, key: string): Promise<void> {
  for (let tries = 0; pipeline.claimed(key) && tries < 500; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function boot(root: string): Promise<TestingModule> {
  await writeFile(
    join(root, '.env'),
    [
      'RUNTIME=cursor',
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=',
      'JIRA_EMAIL=',
      'JIRA_API_TOKEN=',
      'GITLAB_BASE_URL=',
      'GITLAB_TOKEN=',
      'GITHUB_BASE_URL=',
      'GITHUB_TOKEN=',
      'CURSOR_API_KEY=',
      'ANTHROPIC_API_KEY=',
      'MAX_AGENT_CALLS=20',
      'MAX_RETURNS=3',
      'MAX_LAUNCHES=3',
      'MAX_RUN_USD=25',
      'IDLE_TIMEOUT_MS=900000',
      'TICK_MS=15000',
      'REQUIREMENTS_TIMEOUT_MS=600000',
      'RESEARCH_TIMEOUT_MS=900000',
      'PLAN_TIMEOUT_MS=1200000',
      'IMPLEMENT_TIMEOUT_MS=1800000',
      'CODE_REVIEW_TIMEOUT_MS=900000',
      'MERGE_REQUEST_TIMEOUT_MS=600000',
      'PIPELINE_TIMEOUT_MS=1800000',
      'PIPELINE_START_TIMEOUT_MS=180000',
      'MODEL_RESEARCH=grok-4.7',
      'MODEL_PLAN=opus-5.5-extra-high',
      'MODEL_IMPLEMENT=grok-4.7',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      '',
    ].join('\n'),
  );
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: jest.fn() })
    .overrideProvider(SandboxService)
    .useValue({ assertReady: jest.fn().mockResolvedValue(undefined) })
    .compile();
}
