import 'reflect-metadata';

import { mkdirSync } from 'fs';

import { mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';

import { FetchFailed } from '../../core/swarmloop-error';

import { gitRepo, two, shot, job, call, restore, boot, seed } from './pipeline.step.spec-helpers';

describe('pipeline step', () => {
  it('returns to implement when a job trace cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-trace-'));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const previousStart = process.env.PIPELINE_START_TIMEOUT_MS;
    const trace = jest.fn(() => Promise.reject(new FetchFailed('gitlab pipeline failed', [call('GET')])));
    const app = await boot(
      root,
      jest.fn(() => Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] })),
      trace,
    );
    try {
      await seed(app, 'PROJ-309');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-309');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline failed');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-309');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(1);
      const notes = await documents.latestBody('PROJ-309', 'return');
      expect(notes).toContain('project: group/demo');
      expect(notes).toContain('pipeline: 9');
      expect(notes).toContain('job: unit');
      expect(notes).toContain('https://gitlab.example/group/demo/-/pipelines/9');
      expect(notes).toContain('gitlab pipeline failed');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      restore('PIPELINE_START_TIMEOUT_MS', previousStart);
      await app.close();
    }
  });

  it('gives two deliveries of the same pipeline log the same issue id, and another log another id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-issue-'));
    let log = 'log A\n';
    const app = await boot(
      root,
      jest.fn(() => Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] })),
      jest.fn(() => Promise.resolve({ trace: log, httpCalls: [call('GET')] })),
    );
    try {
      const ids: string[] = [];
      for (const key of ['PROJ-320', 'PROJ-321', 'PROJ-322']) {
        if (key === 'PROJ-322') {
          log = 'log B\n';
        }
        await seed(app, key);
        await app.get(PipelineService).step('pipeline', key);
        const issues = JSON.parse((await app.get(DocumentRepository).latestBody(key, 'issues')) ?? '[]') as {
          id: string;
          source: string;
        }[];
        expect(issues).toHaveLength(1);
        expect(issues[0]?.source).toBe('pipeline');
        ids.push(issues[0]?.id ?? '');
      }
      expect(ids[0]).toMatch(/^pipeline-[0-9a-f]{10}$/);
      expect(ids[1]).toBe(ids[0]);
      expect(ids[2]).not.toBe(ids[0]);
    } finally {
      await app.close();
    }
  });

  it('waits for a run that is not registered yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-late-'));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    let reads = 0;
    const read = jest.fn(() => {
      reads += 1;
      return Promise.resolve(
        reads === 1
          ? { snapshot: null, httpCalls: [call('GET')] }
          : { snapshot: shot('success', []), httpCalls: [call('GET')] },
      );
    });
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=5000\n');
    try {
      await seed(app, 'PROJ-310');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-310');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect((await app.get(RunRepository).findRun('PROJ-310'))?.currentStep).toBe('done');
      expect(await app.get(DocumentRepository).latestBody('PROJ-310', 'pipeline_log')).toContain('result: pass');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      await app.close();
    }
  });

  it('goes on green when the worktree has no workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-none-'));
    const read = jest.fn(() => Promise.resolve({ snapshot: null, httpCalls: [call('GET')] }));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=30\n');
    try {
      await seed(app, 'PROJ-307');
      const run = await app.get(RunRepository).findRun('PROJ-307');
      await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\n');
      mkdirSync(join(root, 'worktrees', 'PROJ-307', 'demo'), { recursive: true });
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-307');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('nothing started');
      expect(read).toHaveBeenCalledTimes(1);
      const after = await app.get(RunRepository).findRun('PROJ-307');
      expect(after?.currentStep).toBe('done');
      expect(after?.status).toBe('done');
      expect(await app.get(DocumentRepository).latestBody('PROJ-307', 'pipeline_log')).toContain('result: none');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      await app.close();
    }
  });

  it('fails when a workflow exists and no run starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-configured-'));
    const read = jest.fn(() => Promise.resolve({ snapshot: null, httpCalls: [call('GET')] }));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const previousStart = process.env.PIPELINE_START_TIMEOUT_MS;
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=50\nPIPELINE_TIMEOUT_MS=1500\n',
    );
    const started = Date.now();
    try {
      await seed(app, 'PROJ-311');
      const run = await app.get(RunRepository).findRun('PROJ-311');
      const host = app.get(CodeHostRegistry).byName('gitlab');
      const diagnose = jest.fn(async () => ({
        reason: 'PR has merge conflicts; rebase onto the latest base.',
        httpCalls: [call('GET')],
      }));
      host.diagnoseMissingPipeline = diagnose;
      await app.get(DocumentRepository).putDocument(run!, 'pipeline_log', 'result: fail\njob: old-test\n');
      await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\n');
      const workflow = join(root, 'worktrees', 'PROJ-311', 'demo', '.github', 'workflows');
      mkdirSync(workflow, { recursive: true });
      await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-311');
      expect(Date.now() - started).toBeLessThan(700);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('demo CI did not start');
      expect(read.mock.calls.length).toBeGreaterThan(1);
      const after = await app.get(RunRepository).findRun('PROJ-311');
      expect(after?.currentStep).toBe('pipeline');
      expect(after?.status).toBe('failed');
      const error = await app.get(DocumentRepository).latestBody('PROJ-311', 'error');
      expect(error).toContain('PR has merge conflicts');
      expect(error).toContain('sha:');
      expect(diagnose).toHaveBeenCalledTimes(1);
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      restore('PIPELINE_START_TIMEOUT_MS', previousStart);
      await app.close();
    }
  });

  it('follows a pipeline that appears during the start window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-appeared-'));
    let reads = 0;
    const read = jest.fn(() => {
      reads += 1;
      return Promise.resolve(
        reads === 1
          ? { snapshot: null, httpCalls: [call('GET')] }
          : { snapshot: shot('success', []), httpCalls: [call('GET')] },
      );
    });
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=5000\nPIPELINE_TIMEOUT_MS=5000\n',
    );
    try {
      await seed(app, 'PROJ-313');
      const run = await app.get(RunRepository).findRun('PROJ-313');
      await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\n');
      gitRepo(join(root, 'worktrees', 'PROJ-313', 'demo'), 'git@gitlab.example:group/demo.git');
      const workflow = join(root, 'worktrees', 'PROJ-313', 'demo', '.github', 'workflows');
      mkdirSync(workflow, { recursive: true });
      await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-313');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect((await app.get(RunRepository).findRun('PROJ-313'))?.currentStep).toBe('done');
      expect(await app.get(DocumentRepository).latestBody('PROJ-313', 'pipeline_log')).toContain('result: pass');
    } finally {
      await app.close();
    }
  });

  it('keeps polling a running pipeline after the start window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-running-past-start-'));
    let reads = 0;
    const read = jest.fn((_ref: { project: string }, _jobs?: boolean) => {
      reads += 1;
      return Promise.resolve({ snapshot: shot(reads < 4 ? 'running' : 'success', []), httpCalls: [call('GET')] });
    });
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=30\nPIPELINE_START_TIMEOUT_MS=40\nPIPELINE_TIMEOUT_MS=500\n',
    );
    try {
      await seed(app, 'PROJ-314');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-314');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(4);
      expect(read.mock.calls.every((entry) => entry[1] === false)).toBe(true);
      expect((await app.get(RunRepository).findRun('PROJ-314'))?.currentStep).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('fails when one workflow never starts and another run passed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-partial-'));
    const read = jest.fn((ref: { project: string }) => {
      if (ref.project === 'group/web') {
        return Promise.resolve({ snapshot: null, httpCalls: [call('GET')] });
      }
      return Promise.resolve({ snapshot: shot('success', []), httpCalls: [call('GET')] });
    });
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const previousStart = process.env.PIPELINE_START_TIMEOUT_MS;
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=800\nPIPELINE_TIMEOUT_MS=5000\n',
    );
    try {
      await seed(app, 'PROJ-312', two);
      const run = await app.get(RunRepository).findRun('PROJ-312');
      await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\nweb\n');
      gitRepo(join(root, 'worktrees', 'PROJ-312', 'demo'), 'git@gitlab.example:group/demo.git');
      gitRepo(join(root, 'worktrees', 'PROJ-312', 'web'), 'git@gitlab.example:group/web.git');
      for (const name of ['demo', 'web']) {
        const workflow = join(root, 'worktrees', 'PROJ-312', name, '.github', 'workflows');
        mkdirSync(workflow, { recursive: true });
        await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
      }
      const started = Date.now();
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-312');
      expect(Date.now() - started).toBeLessThan(2500);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('web CI did not start');
      expect(read.mock.calls.length).toBeGreaterThan(2);
      const after = await app.get(RunRepository).findRun('PROJ-312');
      expect(after?.currentStep).toBe('pipeline');
      expect(after?.status).toBe('failed');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      restore('PIPELINE_START_TIMEOUT_MS', previousStart);
      await app.close();
    }
  });
});
