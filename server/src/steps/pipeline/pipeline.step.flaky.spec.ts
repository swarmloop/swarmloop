import 'reflect-metadata';

import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { DocumentRepository } from '../../history/document.repository';
import { FlakyTestRepository } from '../../history/flaky-test.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { renderMergeRequest } from '../merge-request/merge-request-record';
import { boot, call, gitRepo, job, one, seed, shot, stampSettled } from './pipeline.step.spec-helpers';
import { FlakyTestEntity } from '../../history/flaky-test.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

const KEY = 'PROJ-330';
const SHA_A = 'a'.repeat(40);
const FAILED_LOG =
  'result: fail\nproject: group/demo\npipeline: 8\njob: unit\nstage: test\n\nunit.test.ts seed 20260101 failed\n';

type App = Awaited<ReturnType<typeof boot>>;

/** A run whose pipeline failed once on `sha`, with a merge request that has a summary. */
async function failedOnce(app: App, sha = SHA_A): Promise<void> {
  await seed(app, KEY, `${one}sha: ${sha}\n`);
  const run = (await app.get(RunRepository).findRun(KEY))!;
  const documents = app.get(DocumentRepository);
  await documents.putDocument(run, 'pipeline_log', FAILED_LOG);
  await documents.putDocument(
    run,
    'merge_request',
    renderMergeRequest([
      {
        project: 'group/demo',
        iid: 1,
        url: 'https://gitlab.example/group/demo/-/merge_requests/1',
        draft: false,
        summary: 'Ships the field.',
      },
    ]),
  );
}

async function bootPassing(root: string, trace = jest.fn()) {
  const updateMergeRequest = jest.fn(() => Promise.resolve({ httpCalls: [call('PUT')] }));
  const read = jest.fn(() =>
    Promise.resolve({ snapshot: shot('success', [job(5, 'unit', false, 'success')]), httpCalls: [call('GET')] }),
  );
  const setDraft = jest.fn(() => Promise.resolve({ httpCalls: [] }));
  const app = await boot(root, read, trace, undefined, undefined, undefined, { updateMergeRequest, setDraft });
  return { app, read, updateMergeRequest };
}

function records(app: App): Promise<FlakyTestEntity[]> {
  return app.get<Repository<FlakyTestEntity>>(getRepositoryToken(FlakyTestEntity)).find();
}

const earlier = {
  runId: 'PROJ-1',
  project: 'group/demo',
  test: 'unit',
  ref: 'feature/other',
  seed: '',
  failedLog: 'x',
  passedLog: 'y',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('pipeline step and flaky tests', () => {
  it('stores a job that failed and passed on the same sha, shows it and goes on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-flaky-'));
    const trace = jest.fn(() => Promise.resolve({ trace: 'passed log\n', httpCalls: [call('GET')] }));
    const { app, updateMergeRequest } = await bootPassing(root, trace);
    try {
      await failedOnce(app);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(await records(app)).toMatchObject([
        {
          runId: KEY,
          project: 'group/demo',
          test: 'unit',
          ref: 'feature/PROJ-300-ship',
          seed: '20260101',
          passedLog: 'passed log\n',
        },
      ]);
      expect(await app.get(DocumentRepository).latestBody(KEY, 'flaky')).toBe('flaky: unit');
      expect(updateMergeRequest).toHaveBeenCalledWith('group/demo', 1, 'Ships the field.\n\nflaky: unit');
      expect(await app.get(DocumentRepository).latestBody(KEY, 'merge_request')).toContain('flaky: unit');
    } finally {
      await app.close();
    }
  });

  it('blocks with TEST_FLAKY when the test has a record on another run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-flaky-block-'));
    const { app } = await bootPassing(
      root,
      jest.fn(() => Promise.resolve({ trace: 'ok\n', httpCalls: [] })),
    );
    try {
      await failedOnce(app);
      await app.get(FlakyTestRepository).record(earlier);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      const message = 'TEST_FLAKY: unit failed and passed on the same code twice; fix the race, not the test';
      expect(result.exitCode).not.toBe(0);
      expect(result.message).toContain(message);
      const run = await app.get(RunRepository).findRun(KEY);
      expect(run?.status).toBe('blocked');
      expect(JSON.parse(run?.stateReason ?? '{}')).toMatchObject({ code: 'TEST_FLAKY' });
      expect(await records(app)).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('records a later commit that touches only the failing test file and keeps the earlier record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-flaky-commit-'));
    const { app } = await bootPassing(
      root,
      jest.fn(() => Promise.resolve({ trace: 'ok\n', httpCalls: [] })),
    );
    try {
      const cwd = join(root, 'worktrees', KEY, 'demo');
      gitRepo(cwd, 'https://gitlab.example/group/demo.git');
      const commit = (message: string): string => {
        execFileSync('git', ['add', '.'], { cwd });
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', message], { cwd });
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
      };
      writeFileSync(join(cwd, 'unit.test.ts'), 'expect(1).toBe(1);\n');
      writeFileSync(join(cwd, 'code.ts'), 'export const a = 1;\n');
      const failedSha = commit('base');
      writeFileSync(join(cwd, 'unit.test.ts'), 'expect(1).toBeGreaterThan(0);\n');
      const passedSha = commit('loosen the assertion');
      await failedOnce(app, failedSha);
      const run = (await app.get(RunRepository).findRun(KEY))!;
      const documents = app.get(DocumentRepository);
      await documents.putDocument(run, 'repos', 'demo\n');
      await documents.putDocument(run, 'pipeline_ref', `${one}sha: ${passedSha}\n`);
      await app.get(FlakyTestRepository).record(earlier);
      await stampSettled(app, KEY, ['demo']);
      await app.get(PipelineService).step('pipeline', KEY);
      const stored = await records(app);
      expect(stored.map((record) => record.runId)).toEqual(['PROJ-1', KEY]);
      expect(await documents.latestBody(KEY, 'flaky')).toBe('flaky: unit');
    } finally {
      await app.close();
    }
  });

  it('does not replace a merge request description it has no stored text for', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-flaky-empty-'));
    const { app, updateMergeRequest } = await bootPassing(
      root,
      jest.fn(() => Promise.resolve({ trace: 'ok\n', httpCalls: [] })),
    );
    try {
      await failedOnce(app);
      const run = (await app.get(RunRepository).findRun(KEY))!;
      const url = 'https://gitlab.example/group/demo/-/merge_requests/1';
      await app
        .get(DocumentRepository)
        .putDocument(
          run,
          'merge_request',
          renderMergeRequest([{ project: 'group/demo', iid: 1, url, draft: false, summary: '' }]),
        );
      await app.get(PipelineService).step('pipeline', KEY);
      expect(await records(app)).toHaveLength(1);
      expect(updateMergeRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('stores nothing and makes no extra host call for a pass with no earlier failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-flaky-none-'));
    const trace = jest.fn();
    const { app, updateMergeRequest } = await bootPassing(root, trace);
    try {
      await seed(app, KEY, `${one}sha: ${SHA_A}\n`);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(await records(app)).toEqual([]);
      expect(await app.get(DocumentRepository).latestBody(KEY, 'flaky')).toBeNull();
      expect(trace).not.toHaveBeenCalled();
      expect(updateMergeRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns a red run to the agent when its failed test has a record on one other run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-flaky-red-'));
    const read = jest.fn(() =>
      Promise.resolve({ snapshot: shot('failed', [job(5, 'unit', false)]), httpCalls: [call('GET')] }),
    );
    const app = await boot(
      root,
      read,
      jest.fn(() => Promise.resolve({ trace: 'boom\n', httpCalls: [] })),
    );
    try {
      await seed(app, KEY, `${one}sha: ${SHA_A}\n`);
      await app.get(FlakyTestRepository).record(earlier);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.message).not.toContain('TEST_FLAKY');
      const run = await app.get(RunRepository).findRun(KEY);
      expect(run?.status).not.toBe('blocked');
      expect(await app.get(DocumentRepository).latestBody(KEY, 'return')).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
