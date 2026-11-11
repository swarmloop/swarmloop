import 'reflect-metadata';

import { mkdirSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { FetchFailed } from '../../core/swarmloop-error';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { renderMergeRequest } from '../merge-request/merge-request-record';
import { boot, call, one, seed, shot, stampSettled, two } from './pipeline.step.spec-helpers';

const KEY = 'PROJ-320';

/** The draft state a fake host keeps for each merge request, and the `setDraft` that changes it. */
function fakeHost(failing = false) {
  const drafts = new Map<string, boolean>([
    ['group/demo!1', true],
    ['group/web!2', true],
  ]);
  const setDraft = jest.fn((project: string, iid: number, draft: boolean) => {
    if (failing) {
      return Promise.reject(new FetchFailed('gitlab merge request failed', [call('PUT')]));
    }
    drafts.set(`${project}!${iid}`, draft);
    return Promise.resolve({ httpCalls: [call('PUT')] });
  });
  return { drafts, setDraft };
}

async function storeRequests(app: Awaited<ReturnType<typeof boot>>, projects: string[], draft: boolean) {
  const run = (await app.get(RunRepository).findRun(KEY))!;
  const records = projects.map((project, index) => ({
    project,
    iid: index + 1,
    url: `https://gitlab.example/${project}/-/merge_requests/${index + 1}`,
    draft,
    summary: 'Ships the field.',
  }));
  await app.get(DocumentRepository).putDocument(run, 'merge_request', renderMergeRequest(records));
}

describe('pipeline step and draft merge requests', () => {
  it('marks every merge request of a run ready before it is done', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-draft-'));
    const host = fakeHost();
    const read = jest.fn(() => Promise.resolve({ snapshot: shot('success', []), httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(), undefined, undefined, undefined, { setDraft: host.setDraft });
    try {
      await seed(app, KEY, two);
      await storeRequests(app, ['group/demo', 'group/web'], true);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      const run = await app.get(RunRepository).findRun(KEY);
      expect(run?.status).toBe('done');
      expect([...host.drafts.values()]).toEqual([false, false]);
      const body = (await app.get(DocumentRepository).latestBody(KEY, 'merge_request')) ?? '';
      expect(body).not.toContain('draft: true');
      expect(body.match(/draft: false/g)).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('does not reach done with a draft merge request when the host refuses to mark it ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-draft-fail-'));
    const host = fakeHost(true);
    const read = jest.fn(() => Promise.resolve({ snapshot: shot('success', []), httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(), undefined, undefined, undefined, { setDraft: host.setDraft });
    try {
      await seed(app, KEY, one);
      await storeRequests(app, ['group/demo'], true);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).not.toBe(0);
      expect((await app.get(RunRepository).findRun(KEY))?.status).not.toBe('done');
      expect(await app.get(DocumentRepository).latestBody(KEY, 'merge_request')).toContain('draft: true');
    } finally {
      await app.close();
    }
  });

  it('marks the merge request ready when CI does not start for a draft, and goes on without a return', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-draft-skip-'));
    const host = fakeHost();
    const read = jest.fn(() =>
      Promise.resolve({
        snapshot: host.drafts.get('group/demo!1') ? null : shot('success', []),
        httpCalls: [call('GET')],
      }),
    );
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=30\n', undefined, undefined, {
      setDraft: host.setDraft,
    });
    try {
      await seed(app, KEY, one);
      const run = await app.get(RunRepository).findRun(KEY);
      await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\n');
      mkdirSync(join(root, 'worktrees', KEY, 'demo'), { recursive: true });
      await stampSettled(app, KEY, ['demo']);
      await storeRequests(app, ['group/demo'], true);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(host.setDraft).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(2);
      const after = await app.get(RunRepository).findRun(KEY);
      expect(after?.status).toBe('done');
      expect(after?.attemptsPipeline).toBe(0);
      expect(await app.get(DocumentRepository).latestBody(KEY, 'pipeline_log')).toContain('result: pass');
    } finally {
      await app.close();
    }
  });

  it('leaves a merge request that is already ready alone when nothing started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-draft-ready-'));
    const host = fakeHost();
    const read = jest.fn(() => Promise.resolve({ snapshot: null, httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=30\n', undefined, undefined, {
      setDraft: host.setDraft,
    });
    try {
      await seed(app, KEY, one);
      const run = await app.get(RunRepository).findRun(KEY);
      await app.get(DocumentRepository).putDocument(run!, 'repos', 'demo\n');
      mkdirSync(join(root, 'worktrees', KEY, 'demo'), { recursive: true });
      await stampSettled(app, KEY, ['demo']);
      await storeRequests(app, ['group/demo'], false);
      const result = await app.get(PipelineService).step('pipeline', KEY);
      expect(result.exitCode).toBe(0);
      expect(host.setDraft).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
      expect((await app.get(RunRepository).findRun(KEY))?.status).toBe('done');
    } finally {
      await app.close();
    }
  });
});
