import 'reflect-metadata';

import { mkdirSync } from 'fs';

import { mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';
import { deriveState } from '../../history/run-state';

import { DocumentRepository } from '../../history/document.repository';

import { stampStored } from '../shared/gate.spec-helpers';
import { PipelineService } from '../../pipeline/pipeline.service';

import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';

import * as delays from '../../core/delay';
import { FetchFailed } from '../../core/swarmloop-error';

import {
  gitRepo,
  two,
  shot,
  job,
  call,
  restore,
  boot,
  fakeWait,
  seed,
  stampSettled,
} from './pipeline.step.spec-helpers';

/** `fakeWait` where the host also sleeps through the first wait. */
function fakeWaitWithSleep(sleepMs: number) {
  const clock = fakeWait();
  let waits = 0;
  jest.mocked(delays.delay).mockImplementation((ms) => {
    waits += 1;
    clock.advance(ms + (waits === 1 ? sleepMs : 0));
    return Promise.resolve();
  });
  return clock;
}

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
      expect(result.message).toContain('CI_LOG_UNAVAILABLE');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-309');
      expect(run?.status).toBe('blocked');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.attemptsPipeline).toBe(0);
      const log = (await documents.latestBody('PROJ-309', 'pipeline_log')) ?? '';
      expect(log).toContain('CI_LOG_UNAVAILABLE');
      expect(log).toContain('unit');
      expect(log).toContain('https://gitlab.example/group/demo/-/pipelines/9');
      expect(log).toContain('gitlab pipeline failed');
      expect(log).toContain('Resume reads the log again.');
      expect(await documents.latestBody('PROJ-309', 'return')).toBeNull();
      expect(await documents.latestBody('PROJ-309', 'issues')).toBeNull();
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
      await stampSettled(app, 'PROJ-307', ['demo']);
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

  it('waits for CI when a workflow exists and no run starts, whatever the host says of the request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-configured-'));
    const read = jest.fn(() => Promise.resolve({ snapshot: null, httpCalls: [call('GET')] }));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const previousStart = process.env.PIPELINE_START_TIMEOUT_MS;
    const clock = fakeWait();
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=50\nPIPELINE_TIMEOUT_MS=1500\n',
      undefined,
      clock,
    );
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
      expect(result.message).toContain('CI has not started for');
      expect(read.mock.calls.length).toBeGreaterThan(1);
      const after = await app.get(RunRepository).findRun('PROJ-311');
      expect(after?.currentStep).toBe('pipeline');
      expect(after?.status).toBe('waiting');
      expect(deriveState(after!).reason?.code).toBe('CI_NOT_STARTED');
      const log = await app.get(DocumentRepository).latestBody('PROJ-311', 'pipeline_log');
      expect(log).toContain('demo CI did not start');
      expect(log).toContain('PR has merge conflicts');
      expect(log).toContain('sha:');
      expect(diagnose).toHaveBeenCalledTimes(1);
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      restore('PIPELINE_START_TIMEOUT_MS', previousStart);
      jest.restoreAllMocks();
      await app.close();
    }
  });

  it.each(['generation', 'files', 'review'] as const)(
    'routes back to code-review when the %s of the stamped gates is stale',
    async (stale) => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-stale-'));
      const read = jest.fn(() => Promise.resolve({ snapshot: null, httpCalls: [call('GET')] }));
      const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=30\n');
      try {
        const key = 'PROJ-330';
        await seed(app, key);
        const runs = app.get(RunRepository);
        const documents = app.get(DocumentRepository);
        await documents.putDocument((await runs.findRun(key))!, 'repos', 'demo\n');
        const tree = join(root, 'worktrees', key, 'demo');
        gitRepo(tree, 'git@gitlab.example:group/demo.git');
        if (stale === 'review') {
          const run = (await runs.findRun(key))!;
          await documents.putDocument(run, 'review_report', 'Ships the field.\n');
          await stampStored(app, run, 'pipeline_ref', ['demo']);
        } else {
          await stampSettled(app, key, ['demo']);
        }
        if (stale === 'generation') await runs.bumpGeneration(key);
        if (stale === 'files') await writeFile(join(tree, 'late.txt'), 'edited after the review\n');
        const result = await app.get(PipelineService).step('pipeline', key);
        expect(result.exitCode).toBe(0);
        expect(result.message).toContain('stale');
        expect((await runs.findRun(key))?.currentStep).toBe('code-review');
        expect(await documents.latestBody(key, 'pipeline_log')).toBeNull();
      } finally {
        await app.close();
      }
    },
  );

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
      await stampSettled(app, 'PROJ-313', ['demo']);
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
    const clock = fakeWait();
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=30\nPIPELINE_START_TIMEOUT_MS=40\nPIPELINE_TIMEOUT_MS=500\n',
      undefined,
      clock,
    );
    try {
      await seed(app, 'PROJ-314');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-314');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(4);
      // The first read is light; the polls read the jobs, so the transcript can say how many of them run.
      expect(read.mock.calls.map((entry) => entry[1])).toEqual([false, true, true, true]);
      expect((await app.get(RunRepository).findRun('PROJ-314'))?.currentStep).toBe('done');
    } finally {
      jest.restoreAllMocks();
      await app.close();
    }
  });

  it('waits for CI when one workflow never starts and another run passed', async () => {
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
    const clock = fakeWait();
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=100\nPIPELINE_START_TIMEOUT_MS=800\nPIPELINE_TIMEOUT_MS=5000\n',
      undefined,
      clock,
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
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-312');
      expect(result.message).toContain('CI has not started for');
      expect(read.mock.calls.length).toBeGreaterThan(2);
      const after = await app.get(RunRepository).findRun('PROJ-312');
      expect(after?.currentStep).toBe('pipeline');
      expect(after?.status).toBe('waiting');
      expect(await app.get(DocumentRepository).latestBody('PROJ-312', 'pipeline_log')).toContain(
        'web CI did not start',
      );
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      restore('PIPELINE_START_TIMEOUT_MS', previousStart);
      jest.restoreAllMocks();
      await app.close();
    }
  });

  describe('when the host sleeps between two polls', () => {
    const SLEEP_MS = 40 * 60_000;

    it('does not cancel a run for the time the host slept, with a poll interval above 15 s', async () => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-sleep-'));
      const clock = fakeWaitWithSleep(SLEEP_MS);
      let reads = 0;
      const read = jest.fn(() => {
        reads += 1;
        return Promise.resolve({ snapshot: shot(reads < 4 ? 'running' : 'success', []), httpCalls: [call('GET')] });
      });
      const cancel = jest.fn(() => Promise.resolve({ httpCalls: [] }));
      const app = await boot(
        root,
        read,
        jest.fn(),
        'TICK_MS=30000\nPIPELINE_START_TIMEOUT_MS=300000\nPIPELINE_TIMEOUT_MS=1800000\n',
        cancel,
        clock,
      );
      try {
        await seed(app, 'PROJ-315');
        const result = await app.get(PipelineService).step('pipeline', 'PROJ-315');
        expect(result.exitCode).toBe(0);
        expect(cancel).not.toHaveBeenCalled();
        expect((await app.get(RunRepository).findRun('PROJ-315'))?.currentStep).toBe('done');
      } finally {
        jest.restoreAllMocks();
        await app.close();
      }
    });

    it('keeps waiting for CI to start for the full start timeout after the host slept', async () => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-sleep-start-'));
      const clock = fakeWaitWithSleep(SLEEP_MS);
      const read = jest.fn(() => {
        return Promise.resolve({ snapshot: null, httpCalls: [call('GET')] });
      });
      const app = await boot(
        root,
        read,
        jest.fn(),
        'TICK_MS=30000\nPIPELINE_START_TIMEOUT_MS=300000\nPIPELINE_TIMEOUT_MS=1800000\n',
        undefined,
        clock,
      );
      try {
        await seed(app, 'PROJ-316');
        const run = await app.get(RunRepository).findRun('PROJ-316');
        await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\n');
        const workflow = join(root, 'worktrees', 'PROJ-316', 'demo', '.github', 'workflows');
        mkdirSync(workflow, { recursive: true });
        await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
        const result = await app.get(PipelineService).step('pipeline', 'PROJ-316');
        expect(result.message).toContain('CI has not started for');
        // 300 s of awake time is ten polls; the sleep adds none.
        expect(read.mock.calls.length).toBeGreaterThanOrEqual(10);
      } finally {
        jest.restoreAllMocks();
        await app.close();
      }
    });

    it('still times out when every poll is slow and the host stayed awake', async () => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-slow-'));
      const clock = fakeWait();
      let canceled = false;
      let reads = 0;
      const read = jest.fn(() => {
        reads += 1;
        clock.advance(100_000);
        const done = canceled || reads > 20;
        return Promise.resolve({
          snapshot: shot(canceled ? 'canceled' : reads > 20 ? 'success' : 'running', [
            job(7, 'unit', false, done ? 'failed' : 'in_progress'),
          ]),
          httpCalls: [call('GET')],
        });
      });
      const cancel = jest.fn(() => {
        canceled = true;
        return Promise.resolve({ httpCalls: [] });
      });
      const app = await boot(
        root,
        read,
        jest.fn(() => Promise.resolve({ trace: 'log 7\n', httpCalls: [] })),
        'TICK_MS=30000\nPIPELINE_START_TIMEOUT_MS=300000\nPIPELINE_TIMEOUT_MS=300000\n',
        cancel,
        clock,
      );
      try {
        await seed(app, 'PROJ-317');
        await app.get(PipelineService).step('pipeline', 'PROJ-317');
        // 300 s of awake time is about three polls of 130 s each.
        expect(read.mock.calls.length).toBeLessThanOrEqual(5);
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        jest.restoreAllMocks();
        await app.close();
      }
    });
  });
});
