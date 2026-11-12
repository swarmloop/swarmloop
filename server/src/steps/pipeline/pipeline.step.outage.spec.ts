import 'reflect-metadata';

import { execFileSync } from 'child_process';

import { mkdirSync } from 'fs';

import { mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import { RunRebase } from '../run-rebase';

import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';

import { FetchFailed, HostUnavailable } from '../../core/swarmloop-error';

import { shot, job, call, boot, fakeWait, seed, gitRepo } from './pipeline.step.spec-helpers';

const RETRY_AT = '2026-11-12T15:00:00.000Z';
const down = () => new HostUnavailable('api.github.com', 'HTTP 503', RETRY_AT, [call('GET')]);
const NEVER_STARTED = [job(1, 'server-test', false, 'queued'), job(2, 'autofix', false, 'queued')];
const RUNNING = 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=0\nPIPELINE_START_TIMEOUT_MS=50\n';

async function expectWaiting(app: Awaited<ReturnType<typeof boot>>, key: string, code = 'HOST_UNAVAILABLE') {
  const run = await app.get(RunRepository).findRun(key);
  expect(run?.status).toBe('waiting');
  expect(JSON.parse(run?.stateReason ?? '{}')).toMatchObject({ code, retryAt: RETRY_AT });
}

describe('pipeline step while the host is down', () => {
  afterEach(() => jest.restoreAllMocks());

  it('waits when the re-run of the jobs never answers', async () => {
    fakeWait();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-outage-rerun-'));
    const read = jest.fn(() => Promise.resolve({ snapshot: shot('failed', NEVER_STARTED), httpCalls: [call('GET')] }));
    const rerunFailedJobs = jest.fn(() => Promise.reject(down()));
    const app = await boot(root, read, jest.fn(), undefined, undefined, undefined, { rerunFailedJobs });
    try {
      await seed(app, 'PROJ-500');
      await app.get(PipelineService).step('pipeline', 'PROJ-500');
      await expectWaiting(app, 'PROJ-500');
      expect(await app.get(DocumentRepository).latestBody('PROJ-500', 'pipeline_log')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('keeps the CI note and blocks when only the note read fails', async () => {
    fakeWait();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-outage-notes-'));
    const read = jest.fn(() => Promise.resolve({ snapshot: shot('failed', NEVER_STARTED), httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(), undefined, undefined, undefined, {
      rerunFailedJobs: jest.fn(() => Promise.resolve({ httpCalls: [call('POST')] })),
      readRunNotes: jest.fn(() => Promise.reject(down())),
    });
    try {
      await seed(app, 'PROJ-501');
      await app.get(PipelineService).step('pipeline', 'PROJ-501');
      const run = await app.get(RunRepository).findRun('PROJ-501');
      expect(run?.status).toBe('blocked');
      expect(await app.get(DocumentRepository).latestBody('PROJ-501', 'pipeline_log')).toContain('CI_NOT_RUN');
    } finally {
      await app.close();
    }
  });

  it('waits when the log of a failed job cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-outage-trace-'));
    const read = jest.fn(() => Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [] }));
    const app = await boot(
      root,
      read,
      jest.fn(() => Promise.reject(down())),
    );
    try {
      await seed(app, 'PROJ-502');
      await app.get(PipelineService).step('pipeline', 'PROJ-502');
      await expectWaiting(app, 'PROJ-502');
      expect(await app.get(DocumentRepository).latestBody('PROJ-502', 'pipeline_log')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('waits when canceling a timed-out run never answers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-outage-cancel-'));
    const read = jest.fn(() =>
      Promise.resolve({ snapshot: shot('running', [job(7, 'unit', false, 'in_progress')]), httpCalls: [] }),
    );
    const app = await boot(
      root,
      read,
      jest.fn(),
      RUNNING,
      jest.fn(() => Promise.reject(down())),
    );
    try {
      await seed(app, 'PROJ-503');
      await app.get(PipelineService).step('pipeline', 'PROJ-503');
      await expectWaiting(app, 'PROJ-503');
    } finally {
      await app.close();
    }
  });

  it('waits when the run cannot be read again after a cancel that failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-outage-reload-'));
    let polls = 0;
    const read = jest.fn(() => {
      polls += 1;
      if (polls > 1) return Promise.reject(down());
      return Promise.resolve({ snapshot: shot('running', [job(7, 'unit', false, 'in_progress')]), httpCalls: [] });
    });
    const cancel = jest.fn(() => Promise.reject(new FetchFailed('github pipeline failed: HTTP 500', [call('POST')])));
    const app = await boot(root, read, jest.fn(), RUNNING, cancel);
    try {
      await seed(app, 'PROJ-504');
      await app.get(PipelineService).step('pipeline', 'PROJ-504');
      await expectWaiting(app, 'PROJ-504');
    } finally {
      await app.close();
    }
  });

  it('waits, not blocked with REBASE_CONFLICT, when the automatic rebase meets the outage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-outage-rebase-'));
    const app = await boot(
      root,
      jest.fn(async () => ({ snapshot: null, httpCalls: [] })),
      jest.fn(),
    );
    try {
      const key = 'PROJ-505';
      const cwd = join(root, 'worktrees', key, 'demo');
      gitRepo(cwd, 'https://gitlab.example/group/demo.git');
      mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
      await writeFile(join(cwd, '.github', 'workflows', 'ci.yml'), 'name: CI\non: pull_request\n');
      execFileSync('git', ['checkout', '-b', 'feature/task'], { cwd });
      execFileSync('git', ['add', '.'], { cwd });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'base'], { cwd });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
      await seed(app, key, `project: group/demo\nref: feature/task\nsha: ${sha}\n`);
      const runs = app.get(RunRepository);
      await app.get(DocumentRepository).putDocument((await runs.findRun(key))!, 'repos', 'demo\n');
      app.get(CodeHostRegistry).byName('gitlab').diagnoseMissingPipeline = jest.fn(async () => ({
        reason: 'MR has conflicts',
        code: 'merge-conflict' as const,
        httpCalls: [],
      }));
      jest.spyOn(app.get(RunRebase), 'rebase').mockRejectedValue(down());
      await app.get(PipelineService).step('pipeline', key);
      await expectWaiting(app, key);
    } finally {
      await app.close();
    }
  });
});
