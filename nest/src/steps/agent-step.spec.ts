import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../config/config.module';
import { SwarmloopEnv } from '../config/env';
import { HistoryService } from '../history/history.service';
import { AGENT_RUNNER, AgentProcessRunner } from '../limits/agent-runner';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PipelineResult, StepName, StepOptions } from '../pipeline/pipeline-result';
import { PASTE_READER } from '../integrations/linked-pages/paste-page.reader';
import { SandboxService } from '../sandbox/sandbox.service';
import { AgentSettings, AgentStep } from './agent-step';

/** Throws whatever the test sets, so each case drives one path through `AgentStep.execute`. */
@Injectable()
class StubStep extends AgentStep {
  readonly name: StepName = 'plan';
  thrown: unknown = null;

  constructor(history: HistoryService, config: ConfigService, sandbox: SandboxService, @Inject(AGENT_RUNNER) agent: AgentProcessRunner) {
    super(history, config, sandbox, agent);
  }

  async missingInput(): Promise<string | null> {
    return null;
  }

  protected settings(env: SwarmloopEnv, options: StepOptions): AgentSettings {
    return { mode: 'plan', model: env.MODEL_PLAN, timeLimitMs: env.PLAN_TIMEOUT_MS, runtime: env.RUNTIME, auto: options.auto };
  }

  protected async body(): Promise<PipelineResult> {
    throw this.thrown;
  }
}

describe('agent step', () => {
  it('records a missing requirements record as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-missing-'));
    const app = await boot(root);
    try {
      const result = await app.get(StubStep).execute('AGENT-1');
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/ requirements is missing$/);
      const history = app.get(HistoryService);
      const run = await history.findRun('AGENT-1');
      expect(run?.status).toBe('failed');
      const visits = (await history.listStats(run?.id ?? 0)).filter((item) => item.step === 'plan');
      expect(visits.map((item) => item.status)).toEqual(['failed']);
    } finally {
      await app.close();
    }
  });

  it('records a plain error from the body as failed with the step fallback text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-agent-plain-'));
    const app = await boot(root);
    try {
      const history = app.get(HistoryService);
      const seeded = await history.begin('AGENT-2', 'plan');
      seeded.status = 'waiting';
      seeded.currentStep = 'plan';
      await history.saveRun(seeded);
      await history.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
      app.get(StubStep).thrown = new Error('boom');
      const result = await app.get(StubStep).execute('AGENT-2');
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/ plan failed$/);
      const run = await history.findRun('AGENT-2');
      expect(run?.status).toBe('failed');
      const documents = await history.listDocuments(run?.id ?? 0);
      expect(documents.filter((document) => document.kind === 'error').map((document) => document.body)).toEqual(['plan failed\n']);
    } finally {
      await app.close();
    }
  });
});

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
    providers: [
      StubStep,
      { provide: SandboxService, useValue: { assertReady: jest.fn().mockResolvedValue(undefined) } },
      { provide: AGENT_RUNNER, useValue: { run: jest.fn() } },
    ],
  })
    .overrideProvider(PASTE_READER)
    .useValue({ read: jest.fn() })
    .compile();
}
