import 'reflect-metadata';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import * as delays from '../../core/delay';
import { FetchFailed } from '../../core/swarmloop-error';
import { ARTIFACTS } from '../contract/artifacts';

import { shot, job, call, boot, fakeWait, seed } from './pipeline.step.spec-helpers';

const LIMIT = 'The job was not started because your account has reached its spending limit.';

/** The #246 shape: every finished job is green and three never started. */
const NEVER_STARTED = [
  job(1, 'server-test', false, 'queued'),
  job(2, 'dashboard-test', false, 'pending'),
  job(3, 'autofix', false, 'queued'),
];

const rerun = () => jest.fn(() => Promise.resolve({ httpCalls: [call('POST')] }));
const notes = (text = LIMIT) => jest.fn(() => Promise.resolve({ notes: text, httpCalls: [call('GET')] }));

function pauses(): number[] {
  return jest.mocked(delays.delay).mock.calls.map((item) => item[0]);
}

describe('pipeline step on a run that did not run', () => {
  afterEach(() => jest.restoreAllMocks());

  async function blockedRun(statuses: string[], status = 'failed', key = 'PROJ-400') {
    fakeWait();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-infra-'));
    const jobs = statuses.map((state, index) => job(index + 1, `job-${index + 1}`, false, state));
    const read = jest.fn(() => Promise.resolve({ snapshot: shot(status, jobs), httpCalls: [call('GET')] }));
    const trace = jest.fn(() => Promise.resolve({ trace: 'log\n', httpCalls: [call('GET')] }));
    const rerunFailedJobs = rerun();
    const app = await boot(root, read, trace, undefined, undefined, undefined, {
      rerunFailedJobs,
      readRunNotes: notes(),
    });
    await seed(app, key);
    const result = await app.get(PipelineService).step('pipeline', key);
    return { app, result, trace, rerunFailedJobs, key };
  }

  it('re-runs at 1 and 5 minutes, then blocks with the jobs and the annotation, and never returns to implement', async () => {
    fakeWait();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-infra-'));
    const read = jest.fn(() => Promise.resolve({ snapshot: shot('failed', NEVER_STARTED), httpCalls: [call('GET')] }));
    const trace = jest.fn();
    const rerunFailedJobs = rerun();
    const app = await boot(root, read, trace, undefined, undefined, undefined, {
      rerunFailedJobs,
      readRunNotes: notes(),
    });
    try {
      await seed(app, 'PROJ-400');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-400');
      expect(result.exitCode).toBe(1);
      expect(rerunFailedJobs.mock.calls).toEqual([
        ['group/demo', 9],
        ['group/demo', 9],
      ]);
      expect(pauses()).toEqual([60_000, 300_000]);
      expect(trace).not.toHaveBeenCalled();
      const run = await app.get(RunRepository).findRun('PROJ-400');
      expect(run?.status).toBe('blocked');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.attemptsPipeline).toBe(0);
      const documents = app.get(DocumentRepository);
      const body = await documents.latestBody('PROJ-400', 'pipeline_log');
      expect(body?.split('\n')[0]).toBe(
        `CI_NOT_RUN: CI did not run server-test, dashboard-test, autofix: ${LIMIT} https://gitlab.example/group/demo/-/pipelines/9`,
      );
      expect(body).toContain('job: server-test');
      expect(await documents.latestBody('PROJ-400', ARTIFACTS.return.kind)).toBeNull();
      const issues = await documents.latestBody('PROJ-400', ARTIFACTS.issues.kind);
      expect(JSON.parse(issues ?? '[]').map((issue: { source: string }) => issue.source)).toEqual(['ci-infra']);
    } finally {
      await app.close();
    }
  });

  it('goes on to done without an implement visit when a re-run ends green', async () => {
    fakeWait();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-infra-green-'));
    let reruns = 0;
    const read = jest.fn(() =>
      Promise.resolve({
        snapshot: reruns === 0 ? shot('failed', NEVER_STARTED) : shot('success', []),
        httpCalls: [call('GET')],
      }),
    );
    const rerunFailedJobs = jest.fn(() => {
      reruns += 1;
      return Promise.resolve({ httpCalls: [call('POST')] });
    });
    const app = await boot(root, read, jest.fn(), undefined, undefined, undefined, { rerunFailedJobs });
    try {
      await seed(app, 'PROJ-401');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-401');
      expect(result.exitCode).toBe(0);
      expect(rerunFailedJobs).toHaveBeenCalledTimes(1);
      expect(pauses()).toEqual([60_000]);
      const run = await app.get(RunRepository).findRun('PROJ-401');
      expect(run?.status).toBe('done');
      expect(run?.attemptsPipeline).toBe(0);
      expect(await app.get(DocumentRepository).latestBody('PROJ-401', 'return')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps today path when one job failed, even with jobs that never ran', async () => {
    fakeWait();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-infra-failed-'));
    const read = jest.fn(() =>
      Promise.resolve({
        snapshot: shot('failed', [job(7, 'unit', false), job(8, 'lint', false, 'queued')]),
        httpCalls: [call('GET')],
      }),
    );
    const trace = jest.fn(() => Promise.resolve({ trace: 'log 7\n', httpCalls: [call('GET')] }));
    const rerunFailedJobs = rerun();
    const app = await boot(root, read, trace, undefined, undefined, undefined, { rerunFailedJobs });
    try {
      await seed(app, 'PROJ-402');
      await app.get(PipelineService).step('pipeline', 'PROJ-402');
      expect(rerunFailedJobs).not.toHaveBeenCalled();
      expect(trace).toHaveBeenCalledWith('group/demo', 7);
      const run = await app.get(RunRepository).findRun('PROJ-402');
      expect(run?.currentStep).toBe('implement');
      expect(run?.attemptsPipeline).toBe(1);
      const returned = await app.get(DocumentRepository).latestBody('PROJ-402', 'return');
      expect(returned).toContain('job: unit');
      expect(returned).toContain('log 7');
    } finally {
      await app.close();
    }
  });

  it('gives CI_TIMEOUT with the job name for a timed-out job', async () => {
    const { app, trace, rerunFailedJobs, key } = await blockedRun(['timed_out']);
    try {
      expect(trace).not.toHaveBeenCalled();
      expect(rerunFailedJobs).toHaveBeenCalledTimes(2);
      const body = await app.get(DocumentRepository).latestBody(key, 'pipeline_log');
      expect(body).toContain('CI_TIMEOUT: job-1 timed out');
      expect((await app.get(RunRepository).findRun(key))?.status).toBe('blocked');
    } finally {
      await app.close();
    }
  });

  it('treats a canceled job of a canceled pipeline as a run that did not run', async () => {
    const { app, trace, rerunFailedJobs, key } = await blockedRun(['canceled'], 'canceled');
    try {
      expect(trace).not.toHaveBeenCalled();
      expect(rerunFailedJobs).toHaveBeenCalledTimes(2);
      expect(await app.get(DocumentRepository).latestBody(key, 'pipeline_log')).toContain(
        'CI_NOT_RUN: CI did not run job-1',
      );
      expect(await app.get(DocumentRepository).latestBody(key, 'return')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('blocks with the error text when a re-run cannot be requested', async () => {
    fakeWait();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-infra-error-'));
    const read = jest.fn(() => Promise.resolve({ snapshot: shot('failed', NEVER_STARTED), httpCalls: [call('GET')] }));
    const rerunFailedJobs = jest.fn(() =>
      Promise.reject(new FetchFailed('github pipeline failed: HTTP 403', [call('POST')])),
    );
    const app = await boot(root, read, jest.fn(), undefined, undefined, undefined, {
      rerunFailedJobs,
      readRunNotes: notes(''),
    });
    try {
      await seed(app, 'PROJ-403');
      await app.get(PipelineService).step('pipeline', 'PROJ-403');
      expect(rerunFailedJobs).toHaveBeenCalledTimes(1);
      expect((await app.get(RunRepository).findRun('PROJ-403'))?.status).toBe('blocked');
      const body = await app.get(DocumentRepository).latestBody('PROJ-403', 'pipeline_log');
      expect(body).toContain('CI_NOT_RUN: CI did not run server-test, dashboard-test, autofix');
      expect(body).toContain('rerun: group/demo: github pipeline failed: HTTP 403');
    } finally {
      await app.close();
    }
  });

  it('keeps the red path for a run that swarmloop canceled after its own timeout', async () => {
    fakeWait();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-infra-timeout-'));
    let canceled = false;
    const read = jest.fn(() =>
      Promise.resolve({
        snapshot: canceled
          ? shot('canceled', [job(7, 'unit', false, 'canceled')])
          : shot('running', [job(7, 'unit', false, 'in_progress')]),
        httpCalls: [call('GET')],
      }),
    );
    const cancel = jest.fn(() => {
      canceled = true;
      return Promise.resolve({ httpCalls: [call('POST')] });
    });
    const trace = jest.fn(() => Promise.resolve({ trace: 'log 7\n', httpCalls: [call('GET')] }));
    const rerunFailedJobs = rerun();
    const app = await boot(
      root,
      read,
      trace,
      'TICK_MS=1\nPIPELINE_TIMEOUT_MS=0\nPIPELINE_START_TIMEOUT_MS=50\n',
      cancel,
      undefined,
      { rerunFailedJobs },
    );
    try {
      await seed(app, 'PROJ-404');
      await app.get(PipelineService).step('pipeline', 'PROJ-404');
      expect(rerunFailedJobs).not.toHaveBeenCalled();
      expect((await app.get(RunRepository).findRun('PROJ-404'))?.currentStep).toBe('implement');
      const returned = await app.get(DocumentRepository).latestBody('PROJ-404', 'return');
      expect(returned).toContain('job: unit');
      expect(returned).toContain('log 7');
    } finally {
      await app.close();
    }
  });
});
