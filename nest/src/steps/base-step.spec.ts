import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../config/config.module';
import { HistoryService } from '../history/history.service';
import { AGENT_RUNNER } from '../limits/agent-runner';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PipelineResult, StepName, StepOptions } from '../pipeline/pipeline-result';
import { PASTE_READER } from '../integrations/linked-pages/paste-page.reader';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../swarmloop-error';
import { BaseStep, StepContext } from './base-step';

/** Throws whatever the test sets, so each case drives one path through `BaseStep.execute`. */
@Injectable()
class StubStep extends BaseStep {
  readonly name: StepName = 'branch';
  readonly requiredKind = 'repos';
  thrown: unknown = null;

  constructor(history: HistoryService) {
    super(history);
  }

  protected async run(_key: string, _options: StepOptions, _ctx: StepContext): Promise<PipelineResult> {
    throw this.thrown;
  }
}

describe('base step', () => {
  it('records a plain error as failed with the step fallback text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-plain-'));
    const app = await boot(root);
    try {
      app.get(StubStep).thrown = new Error('boom');
      const result = await app.get(StubStep).execute('BASE-1');
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/ branch failed$/);
      const history = app.get(HistoryService);
      const run = await history.findRun('BASE-1');
      expect(run?.status).toBe('failed');
      const documents = await history.listDocuments(run?.id ?? 0);
      expect(documents.filter((document) => document.kind === 'error').map((document) => document.body)).toEqual(['branch failed\n']);
    } finally {
      await app.close();
    }
  });

  it('uses a SwarmloopError message as the failure line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-swarmloop-'));
    const app = await boot(root);
    try {
      app.get(StubStep).thrown = new SwarmloopError('repos is missing');
      const result = await app.get(StubStep).execute('BASE-2');
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/ repos is missing$/);
      expect(result.message).not.toContain('branch failed');
    } finally {
      await app.close();
    }
  });

  it('keeps the http calls of a FetchFailed in the visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-fetch-'));
    const app = await boot(root);
    try {
      const call: HttpCallDraft = {
        provider: 'jira',
        method: 'GET',
        url: 'https://jira.example.com/rest/api/3/issue/BASE-3',
        statusCode: 503,
        durationMs: 12,
        error: 'unavailable',
      };
      app.get(StubStep).thrown = new FetchFailed('jira is down', [call]);
      const result = await app.get(StubStep).execute('BASE-3');
      expect(result.message).toMatch(/ jira is down$/);
      const history = app.get(HistoryService);
      const run = await history.findRun('BASE-3');
      const calls = await history.listHttpCalls(run?.id ?? 0);
      expect(calls.map((item) => [item.provider, item.url, item.statusCode])).toEqual([[call.provider, call.url, call.statusCode]]);
    } finally {
      await app.close();
    }
  });

  it('reports the required document kind when it is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-missing-'));
    const app = await boot(root);
    try {
      expect(await app.get(StubStep).missingInput('BASE-4')).toBe('repos');
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
    providers: [StubStep],
  })
    .overrideProvider(PASTE_READER)
    .useValue({ read: jest.fn() })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: jest.fn() })
    .compile();
}
