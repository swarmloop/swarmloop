import 'reflect-metadata';

import { execFileSync } from 'child_process';

import { Test } from '@nestjs/testing';

import { mkdirSync } from 'fs';

import { writeFile } from 'fs/promises';

import { join } from 'path';

import { SwarmloopConfigModule } from '../../config/config.module';

import { AppConfig } from '../../config/env';

import { Clock } from '../../core/clock';

import * as delays from '../../core/delay';

import { FakeClock } from '../../core/fake-clock.spec-helpers';

import { RunRepository } from '../../history/run.repository';

import { stampStored } from '../shared/gate.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';

import { PipelineModule } from '../../pipeline/pipeline.module';

import type { PipelineCheck, PipelineJob, PipelineSnapshot } from '../../integrations/code-host/code-host';

import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';

import { type HttpCallDraft } from '../../core/swarmloop-error';

export const TOKEN = 'super-secret-token';

export function gitRepo(dir: string, origin: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
}

export const one = `project: group/demo\nref: feature/PROJ-300-ship\n`;

export const two = `${one}\nproject: group/web\nref: feature/PROJ-300-ship\n`;

export function shot(
  status: string,
  jobs: PipelineJob[],
  checks: PipelineCheck[] = [],
  awaiting: string[] = [],
): PipelineSnapshot {
  const url = 'https://gitlab.example/group/demo/-/pipelines/9';
  return { id: 9, status, url, jobs, runs: [{ id: 9, status, url, jobs }], checks, awaiting };
}

/** A check that no workflow ran, such as code scanning or a commit status of another app. */
export function appCheck(overrides: Partial<PipelineCheck> = {}): PipelineCheck {
  return {
    id: 31,
    name: 'Code scanning results',
    app: 'CodeQL',
    status: 'failed',
    durationMs: 0,
    url: 'https://github.example/group/demo/pull/1/checks',
    summary: '',
    annotations: [],
    workflow: false,
    ...overrides,
  };
}

/** The snapshot of a commit whose workflow run is `runStatus` and whose other checks are `checks`. */
export function withChecks(runStatus: string, checks: PipelineCheck[], awaiting: string[] = []): PipelineSnapshot {
  const base = shot(runStatus, []);
  const red = checks.find((check) => !check.workflow && check.status === 'failed');
  const statuses = [runStatus, ...checks.map((check) => check.status)];
  const status = ['failed', 'running'].find((wanted) => statuses.includes(wanted)) ?? 'success';
  return { ...base, status: runStatus === 'failed' ? 'failed' : status, id: red ? red.id : base.id, checks, awaiting };
}

export function job(id: number, name: string, allowFailure: boolean, status = 'failed'): PipelineJob {
  return { id, name, stage: 'test', status, allowFailure };
}

export function call(method: string): HttpCallDraft {
  return {
    provider: 'gitlab',
    method,
    url: 'https://gitlab.example/api/v4/projects/group%2Fdemo/pipelines',
    statusCode: 200,
    durationMs: 1,
    error: null,
  };
}

export function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** A clock that the step's waits advance, so a spec never waits in wall time. Restore with jest.restoreAllMocks(). */
export function fakeWait(): FakeClock {
  const clock = new FakeClock();
  jest.spyOn(delays, 'delay').mockImplementation((ms) => {
    clock.advance(ms);
    return Promise.resolve();
  });
  return clock;
}

export async function boot(
  root: string,
  read: jest.Mock,
  trace: jest.Mock,
  extra = 'PIPELINE_TIMEOUT_MS=0\n',
  cancel: jest.Mock = jest.fn(() => Promise.resolve({ httpCalls: [] as HttpCallDraft[] })),
  clock?: Clock,
  infra: {
    rerunFailedJobs?: jest.Mock;
    readRunNotes?: jest.Mock;
    setDraft?: jest.Mock;
    updateMergeRequest?: jest.Mock;
  } = {},
) {
  await writeFile(
    join(root, '.env'),
    [
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=',
      'JIRA_EMAIL=',
      'JIRA_API_TOKEN=',
      'GITLAB_BASE_URL=https://gitlab.example',
      `GITLAB_TOKEN=${TOKEN}`,
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
      'AGENTS_PLAN=cursor:opus-5.5-extra-high',
      'AGENTS_IMPLEMENT=cursor:grok-4.7',
      'AGENTS_REVIEW=cursor:opus-5.5-extra-high',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      extra,
    ].join('\n'),
  );
  const builder = Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  });
  if (clock) {
    builder.overrideProvider(Clock).useValue(clock);
  }
  return builder
    .overrideProvider(CodeHostRegistry)
    .useFactory({
      factory: (config: AppConfig, clock: Clock) => {
        const registry = CodeHostRegistry.create(config.env, clock);
        jest.spyOn(registry, 'byName').mockReturnValue({
          findMergeRequest: jest.fn(),
          openMergeRequest: jest.fn(),
          readBranchPipeline: read,
          readJobTrace: trace,
          cancelPipeline: cancel,
          ...infra,
        } as never);
        return registry;
      },
      inject: [AppConfig, Clock],
    })
    .compile();
}

export async function seed(
  app: Awaited<ReturnType<typeof boot>>,
  key: string,
  body = one,
  attemptsPipeline = 0,
): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'pipeline');
  seeded.status = 'waiting';
  seeded.currentStep = 'commit';
  seeded.codeHost = 'gitlab';
  seeded.attemptsPipeline = attemptsPipeline;
  await runs.saveRun(seeded);
  await documents.putDocument(seeded, 'pipeline_ref', body);
}

/** The review report and the published refs of a run that passed code-review on the worktrees of `repos`. */
export async function stampSettled(app: Awaited<ReturnType<typeof boot>>, key: string, repos: string[]): Promise<void> {
  const run = (await app.get(RunRepository).findRun(key))!;
  await app.get(DocumentRepository).putDocument(run, 'review_report', 'Ships the field.\n');
  for (const kind of ['pipeline_ref', 'review_report']) {
    await stampStored(app, run, kind, repos);
  }
}
