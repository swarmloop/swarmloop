import 'reflect-metadata';

import { mkdirSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { RunStop } from '../../agent/run-stop';
import { PipelinesRefused } from '../../core/swarmloop-error';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import type { PipelineRef } from '../../integrations/code-host/code-host';
import { PipelineService } from '../../pipeline/pipeline.service';
import { renderMergeRequest } from '../merge-request/merge-request-record';
import {
  appCheck,
  boot,
  call,
  fakeWait,
  gitRepo,
  one,
  seed,
  shot,
  stampSettled,
  two,
} from './pipeline.step.spec-helpers';

const KEY = 'PROJ-330';
const REFUSED = 'the code host refuses to read pipelines (HTTP 403)';
const refuse = () => Promise.reject(new PipelinesRefused([call('GET')]));
/** A host whose branches never had a pipeline: nothing on any commit, nothing on the whole branch. */
const nothing = () => Promise.resolve({ snapshot: null, httpCalls: [call('GET')] });
const never = jest.fn(() => Promise.resolve({ found: false, httpCalls: [] }));

type App = Awaited<ReturnType<typeof boot>>;

/** One worktree of the run, on a host origin, with the review and published refs settled, and one merge request. */
async function settledRun(app: App, root: string, draft: boolean, body = one): Promise<void> {
  await seed(app, KEY, body);
  const run = await app.get(RunRepository).findRun(KEY);
  await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\n');
  gitRepo(join(root, 'worktrees', KEY, 'demo'), 'https://gitlab.example/group/demo.git');
  await stampSettled(app, KEY, ['demo']);
  const record = { project: 'group/demo', iid: 1, url: 'https://gitlab.example/group/demo/-/merge_requests/1', draft };
  await app
    .get(DocumentRepository)
    .putDocument(run!, 'merge_request', renderMergeRequest([{ ...record, summary: 'x' }]));
}

/** A workflow file in the run's worktree, so its tree has CI. */
async function withCiFile(root: string): Promise<void> {
  const workflow = join(root, 'worktrees', KEY, 'demo', '.github', 'workflows');
  mkdirSync(workflow, { recursive: true });
  await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
}

function setDraft() {
  const drafts = new Map<string, boolean>([['group/demo!1', true]]);
  const mock = jest.fn((project: string, iid: number, draft: boolean) => {
    drafts.set(`${project}!${iid}`, draft);
    return Promise.resolve({ httpCalls: [call('PUT')] });
  });
  return { drafts, mock };
}

describe('pipeline step and projects with no CI', () => {
  afterEach(() => jest.restoreAllMocks());

  it('waits for a merge request check when main never had a pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-mr-check-'));
    const withCheck = { ...shot('success', []), runs: [], checks: [appCheck({ status: 'success' })] };
    const read = jest.fn(() => Promise.resolve({ snapshot: withCheck, httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(), undefined, undefined, undefined, { readBranchHasPipeline: never });
    try {
      await seed(app, KEY, one);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline done');
      expect((await app.get(RunRepository).findRun(KEY))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('waits for a merge request pipeline that shows up on a later tick of the start wait', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-late-mr-'));
    const clock = fakeWait();
    let looks = 0;
    const read = jest.fn((_ref: PipelineRef) => {
      looks += 1;
      return Promise.resolve({ snapshot: looks < 3 ? null : shot('success', []), httpCalls: [call('GET')] });
    });
    const app = await boot(
      root,
      read,
      jest.fn(),
      'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=50\nPIPELINE_TIMEOUT_MS=1500\n',
      undefined,
      clock,
      { readBranchHasPipeline: never },
    );
    try {
      const workflow = join(root, 'worktrees', KEY, 'demo', '.github', 'workflows');
      mkdirSync(workflow, { recursive: true });
      await writeFile(join(workflow, 'test.yml'), 'name: Test\non: pull_request\n');
      await settledRun(app, root, false);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(await app.get(DocumentRepository).latestBody(KEY, 'pipeline_log')).toContain('result: pass');
    } finally {
      await app.close();
    }
  });

  it('ends skipped with the cause and marks the merge request ready when the host refuses every pipeline read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-refused-'));
    const host = setDraft();
    const app = await boot(root, jest.fn(refuse), jest.fn(), undefined, undefined, undefined, {
      readBranchHasPipeline: jest.fn(refuse),
      setDraft: host.mock,
    });
    try {
      await settledRun(app, root, true);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain(`CI skipped: no CI on group/demo (${REFUSED})`);
      expect(host.drafts.get('group/demo!1')).toBe(false);
      expect(await app.get(DocumentRepository).latestBody(KEY, 'merge_request')).toContain('draft: false');
      expect((await app.get(RunRepository).findRun(KEY))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('ends skipped, without the CI wait, for a refused project whose tree has a CI file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-refused-file-'));
    const clock = fakeWait();
    const started = clock.now();
    const app = await boot(
      root,
      jest.fn(refuse),
      jest.fn(),
      'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=50\nPIPELINE_TIMEOUT_MS=1500\n',
      undefined,
      clock,
      { readBranchHasPipeline: jest.fn(refuse) },
    );
    try {
      await withCiFile(root);
      await settledRun(app, root, false);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain(`CI skipped: no CI on group/demo (${REFUSED})`);
      expect(clock.now()).toBe(started);
      expect((await app.get(RunRepository).findRun(KEY))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('marks the draft ready and ends skipped on the first pass for a refused project whose tree has a CI file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-refused-draft-'));
    const clock = fakeWait();
    const started = clock.now();
    const host = setDraft();
    const app = await boot(
      root,
      jest.fn(refuse),
      jest.fn(),
      'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=50\nPIPELINE_TIMEOUT_MS=1500\n',
      undefined,
      clock,
      { readBranchHasPipeline: jest.fn(refuse), setDraft: host.mock },
    );
    try {
      await withCiFile(root);
      await settledRun(app, root, true);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain(`CI skipped: no CI on group/demo (${REFUSED})`);
      expect(host.drafts.get('group/demo!1')).toBe(false);
      expect(await app.get(DocumentRepository).latestBody(KEY, 'merge_request')).toContain('draft: false');
      expect(clock.now()).toBe(started);
    } finally {
      await app.close();
    }
  });

  it('does not mark a draft ready for a run with no CI that was asked to stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-no-ci-stop-'));
    const host = setDraft();
    const app = await boot(root, jest.fn(refuse), jest.fn(), undefined, undefined, undefined, {
      readBranchHasPipeline: jest.fn(refuse),
      setDraft: host.mock,
    });
    try {
      await settledRun(app, root, true);
      jest.spyOn(app.get(RunStop), 'halted').mockReturnValue(true);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.message).toContain('Stopped by request');
      expect(host.drafts.get('group/demo!1')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('goes back to code-review, not skipped, when the stamped gates of a run with no CI are stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-no-ci-stale-'));
    const app = await boot(root, jest.fn(nothing), jest.fn(), undefined, undefined, undefined, {
      readBranchHasPipeline: never,
    });
    try {
      await settledRun(app, root, false);
      await app.get(RunRepository).bumpGeneration(KEY);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline result is stale: back to code-review');
      expect((await app.get(RunRepository).findRun(KEY))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('ends skipped when no pipeline exists on main, on the head or on the branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-nothing-'));
    const app = await boot(root, jest.fn(nothing), jest.fn(), undefined, undefined, undefined, {
      readBranchHasPipeline: never,
    });
    try {
      await settledRun(app, root, false);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('CI skipped: no CI on group/demo');
      expect(result.message).toContain('no pipeline was ever run');
      expect((await app.get(RunRepository).findRun(KEY))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('passes a run whose other project has CI and names the project with none in the log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-mixed-'));
    const read = jest.fn((ref: PipelineRef) =>
      ref.project === 'group/demo'
        ? Promise.resolve({ snapshot: shot('success', []), httpCalls: [call('GET')] })
        : nothing(),
    );
    const app = await boot(root, read, jest.fn(), undefined, undefined, undefined, { readBranchHasPipeline: never });
    try {
      await seed(app, KEY, two);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      const log = (await app.get(DocumentRepository).latestBody(KEY, 'pipeline_log')) ?? '';
      expect(log).toContain('result: pass');
      expect(log).toContain('project: group/demo');
      expect(log).not.toContain('project: group/web');
      expect(log).toContain('no CI: group/web (no pipeline was ever run');
    } finally {
      await app.close();
    }
  });

  it('ends a run recorded with three refused projects skipped, with its merge request ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-bootstrap-'));
    const host = setDraft();
    const app = await boot(root, jest.fn(refuse), jest.fn(), undefined, undefined, undefined, {
      readBranchHasPipeline: jest.fn(refuse),
      setDraft: host.mock,
    });
    const three = `${two}\nproject: group/fork\nref: feature/PROJ-300-ship\n`;
    try {
      await settledRun(app, root, true, three);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain(`no CI on group/demo (${REFUSED})`);
      expect(result.message).toContain('no CI on group/fork');
      expect(host.drafts.get('group/demo!1')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('ends skipped with the text of a commit that had no origin to push', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-ci-skip-'));
    const app = await boot(root, jest.fn(nothing), jest.fn());
    try {
      await seed(app, KEY, '');
      const run = await app.get(RunRepository).findRun(KEY);
      await app.get(DocumentRepository).putDocument(run!, 'ci_skip', 'CI skipped: there is no origin to push.\n');
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('CI skipped: there is no origin to push.');
    } finally {
      await app.close();
    }
  });
});
