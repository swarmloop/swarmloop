import 'reflect-metadata';
import { getRepositoryToken } from '@nestjs/typeorm';
import { readFileSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { HttpCallEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import type { MergeRequestDraft } from '../../integrations/code-host/code-host';
import { FetchFailed, NothingToMerge } from '../../core/swarmloop-error';
import { NOTHING_TO_MERGE } from './nothing-to-merge';
import { ARTIFACTS } from '../contract/artifacts';
import { git } from '../../testing/git-fixture';
import { boot, call, featureTree, result, seed, TOKEN } from './merge-request.spec-helpers';

describe('merge-request step', () => {
  it('opens one merge request and stores the summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-open-'));
    featureTree(root, 'PROJ-200');
    const find = jest.fn(async () => ({ record: null, httpCalls: [call('GET')] }));
    const open = jest.fn(async (_draft: MergeRequestDraft) => ({
      record: {
        project: 'group/demo',
        iid: 12,
        url: 'https://gitlab.example/group/demo/-/merge_requests/12',
        summary: '',
        draft: true,
      },
      httpCalls: [call('POST')],
    }));
    const agent = jest.fn(async (_input: { mounts: { readonly?: boolean }[]; prompt: string }) =>
      result('Ships the field.\n'),
    );
    const app = await boot(root, { find, open }, agent);
    try {
      await seed(app, 'PROJ-200');
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-200');
      expect(opened.exitCode).toBe(0);
      expect(open.mock.calls.map((entry) => entry[0].project)).toEqual(['group/demo']);
      expect(open.mock.calls[0]?.[0]).toMatchObject({
        project: 'group/demo',
        source: 'feature/PROJ-200-ship-the-field',
        target: 'main',
        title: 'Ship the field',
        summary: 'Ships the field.',
        draft: true,
      });
      expect(agent).not.toHaveBeenCalled();
      const body = await app.get(DocumentRepository).latestBody('PROJ-200', 'merge_request');
      expect(body).toContain('project: group/demo');
      expect(body).toContain('iid: 12');
      expect(body).toContain('draft: true');
      expect(body).toContain('https://gitlab.example/group/demo/-/merge_requests/12');
      expect(body).toContain('Ships the field.');
      const run = await app.get(RunRepository).findRun('PROJ-200');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.status).toBe('waiting');
      expect(readFileSync(join(root, 'data', 'swarmloop.sqlite')).toString('utf8')).not.toContain(TOKEN);
    } finally {
      await app.close();
    }
  });

  it('notes on the run that drafts are not available when the host opened a normal merge request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-open-'));
    featureTree(root, 'PROJ-200');
    const find = jest.fn(async () => ({ record: null, httpCalls: [call('GET')] }));
    const open = jest.fn(async (_draft: MergeRequestDraft) => ({
      record: {
        project: 'group/demo',
        iid: 12,
        url: 'https://gitlab.example/group/demo/-/merge_requests/12',
        summary: '',
        draft: false,
      },
      draftsUnavailable: true,
      httpCalls: [call('POST')],
    }));
    const agent = jest.fn(async (_input: { mounts: { readonly?: boolean }[]; prompt: string }) =>
      result('Ships the field.\n'),
    );
    const app = await boot(root, { find, open }, agent);
    try {
      await seed(app, 'PROJ-200');
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-200');
      expect(opened.exitCode).toBe(0);
      expect(opened.message).toContain('drafts not available here');
      expect(await app.get(DocumentRepository).latestBody('PROJ-200', 'merge_request')).toContain('draft: false');
    } finally {
      await app.close();
    }
  });

  it('puts the rendered report into the description when the run has the parts of the new report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-report-'));
    featureTree(root, 'PROJ-230');
    const find = jest.fn(async () => ({
      record: { project: 'group/demo', iid: 9, url: 'https://gitlab.example/mr/9', summary: 'Open.', draft: true },
      httpCalls: [call('GET')],
    }));
    const update = jest.fn(async () => ({ httpCalls: [call('PUT')] }));
    const app = await boot(root, { find, open: jest.fn(), update }, jest.fn());
    try {
      await seed(app, 'PROJ-230');
      const run = (await app.get(RunRepository).findRun('PROJ-230'))!;
      const notes = { requirements: 'a', quality: 'b', regressions: 'c', security: 'd', performance: 'e' };
      const parts = { line: 'The field ships.', done: ['x'], worthALook: [], notes, risk: 'low', riskReason: 'small' };
      await app.get(DocumentRepository).putDocument(run, 'review_report_result', JSON.stringify(parts));
      await app.get(PipelineService).step('merge-request', 'PROJ-230');
      const sent = (update.mock.calls[0] as unknown as [string, number, string])[2];
      expect(sent).toContain('## ⏳ Waiting for CI · risk: low\n> The field ships.');
      expect(sent).not.toContain('Ships the field.');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates an open merge request with the new description', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-reuse-'));
    featureTree(root, 'PROJ-201');
    const find = jest.fn(async () => ({
      record: {
        project: 'group/demo',
        iid: 9,
        url: 'https://gitlab.example/group/demo/-/merge_requests/9',
        summary: 'Already open.',
        draft: true,
      },
      httpCalls: [call('GET')],
    }));
    const open = jest.fn();
    const update = jest.fn(async () => ({ httpCalls: [call('PUT')] }));
    const agent = jest.fn(async () => result('Ships the field.\n'));
    const app = await boot(root, { find, open, update }, agent);
    try {
      await seed(app, 'PROJ-201');
      const reused = await app.get(PipelineService).step('merge-request', 'PROJ-201');
      expect(reused.exitCode).toBe(0);
      expect(open).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith('group/demo', 9, 'Ships the field.');
      const body = await app.get(DocumentRepository).latestBody('PROJ-201', 'merge_request');
      expect(body).toContain('iid: 9');
      expect(body).toContain('Ships the field.');
      expect((await app.get(RunRepository).findRun('PROJ-201'))?.currentStep).toBe('pipeline');
    } finally {
      await app.close();
    }
  });

  it('skips an existing merge request marked by a done rebase and updates on the next visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-skip-'));
    featureTree(root, 'PROJ-212');
    const find = jest.fn(async () => ({
      record: {
        project: 'group/demo',
        iid: 9,
        url: 'https://gitlab.example/group/demo/-/merge_requests/9',
        summary: 'Already open.',
        draft: true,
      },
      httpCalls: [call('GET')],
    }));
    const open = jest.fn();
    const update = jest.fn(async () => ({ httpCalls: [call('PUT')] }));
    const app = await boot(
      root,
      { find, open, update },
      jest.fn(async () => result('Ships the field.\n')),
    );
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      await seed(app, 'PROJ-212');
      const run = await runs.findRun('PROJ-212');
      if (!run) {
        throw new Error('run is missing');
      }
      await documents.putDocument(run, ARTIFACTS.rebaseMergeSkip.kind, 'skip\n');
      const skipped = await app.get(PipelineService).step('merge-request', 'PROJ-212');
      expect(skipped.exitCode).toBe(0);
      expect(open).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(await documents.latestBody('PROJ-212', 'merge_request')).toContain('Already open.');
      expect((await documents.latestBody('PROJ-212', ARTIFACTS.rebaseMergeSkip.kind))?.trim()).toBe('clear');
      expect((await runs.findRun('PROJ-212'))?.currentStep).toBe('pipeline');
      expect((await runs.findRun('PROJ-212'))?.status).toBe('waiting');
      const again = await app.get(PipelineService).step('merge-request', 'PROJ-212');
      expect(again.exitCode).toBe(0);
      expect(update).toHaveBeenCalledWith('group/demo', 9, 'Ships the field.');
    } finally {
      await app.close();
    }
  });

  it('creates only the missing merge request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-partial-'));
    featureTree(root, 'PROJ-202', 'demo');
    featureTree(root, 'PROJ-202', 'web');
    const find = jest.fn(async (query: { project: string }) => {
      if (query.project === 'group/web') {
        return {
          record: {
            project: 'group/web',
            iid: 4,
            url: 'https://gitlab.example/group/web/-/merge_requests/4',
            summary: 'Web is open.',
            draft: true,
          },
          httpCalls: [call('GET')],
        };
      }
      return { record: null, httpCalls: [call('GET')] };
    });
    const open = jest.fn(async (_draft: MergeRequestDraft) => ({
      record: {
        project: 'group/demo',
        iid: 12,
        url: 'https://gitlab.example/group/demo/-/merge_requests/12',
        summary: '',
        draft: true,
      },
      httpCalls: [call('POST')],
    }));
    const update = jest.fn(async () => ({ httpCalls: [call('PUT')] }));
    const agent = jest.fn(async (input: { mounts: { containerPath: string }[] }) =>
      result((input.mounts[0]?.containerPath ?? '').includes('web') ? 'Web change.\n' : 'Demo change.\n'),
    );
    const app = await boot(root, { find, open, update }, agent);
    try {
      await seed(app, 'PROJ-202', { repos: 'demo\nweb\n' });
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-202');
      expect(opened.exitCode).toBe(0);
      expect(find.mock.calls.map((entry) => entry[0].project).sort()).toEqual(['group/demo', 'group/web']);
      expect(agent).not.toHaveBeenCalled();
      expect(open.mock.calls.map((entry) => entry[0].project)).toEqual(['group/demo']);
      expect(open.mock.calls[0]?.[0]?.summary).toBe('Ships the field.');
      expect(update).toHaveBeenCalledWith('group/web', 4, 'Ships the field.');
      const body = await app.get(DocumentRepository).latestBody('PROJ-202', 'merge_request');
      expect(body).toContain('iid: 4');
      expect(body).toContain('iid: 12');
      expect(body).toContain('Ships the field.');
    } finally {
      await app.close();
    }
  });

  it('ends done with nothing to merge and opens no request when the branch is at its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-nothing-'));
    featureTree(root, 'PROJ-220', 'demo', true, false);
    const find = jest.fn(async () => ({ record: null, httpCalls: [call('GET')] }));
    const open = jest.fn();
    const app = await boot(root, { find, open }, jest.fn());
    try {
      await seed(app, 'PROJ-220');
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-220');
      expect(opened.exitCode).toBe(0);
      expect(opened.message).toContain(NOTHING_TO_MERGE);
      expect(opened.message).toContain('changed the field');
      expect(open).not.toHaveBeenCalled();
      expect(await app.get(DocumentRepository).latestBody('PROJ-220', 'merge_request')).toBeFalsy();
      const posts = (await app.get<Repository<HttpCallEntity>>(getRepositoryToken(HttpCallEntity)).find()).filter(
        (entry) => entry.method === 'POST',
      );
      expect(posts).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('ends done when the host says there are no commits between', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-nocommits-'));
    featureTree(root, 'PROJ-221');
    const find = jest.fn(async () => ({ record: null, httpCalls: [call('GET')] }));
    const open = jest.fn(async () => {
      throw new NothingToMerge('Validation Failed: No commits between main and the branch', [call('POST', 422)]);
    });
    const app = await boot(root, { find, open }, jest.fn());
    try {
      await seed(app, 'PROJ-221');
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-221');
      expect(opened.exitCode).toBe(0);
      expect(opened.message).toContain(NOTHING_TO_MERGE);
      expect(await app.get(DocumentRepository).latestBody('PROJ-221', 'merge_request')).toBeFalsy();
    } finally {
      await app.close();
    }
  });

  it('opens a request only for the repository with work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-onework-'));
    featureTree(root, 'PROJ-222', 'demo');
    featureTree(root, 'PROJ-222', 'web', true, false);
    const find = jest.fn(async () => ({ record: null, httpCalls: [call('GET')] }));
    const open = jest.fn(async (draft: MergeRequestDraft) => ({
      record: {
        project: draft.project,
        iid: 12,
        url: `https://gitlab.example/${draft.project}/-/merge_requests/12`,
        summary: '',
        draft: true,
      },
      httpCalls: [call('POST')],
    }));
    const app = await boot(root, { find, open }, jest.fn());
    try {
      await seed(app, 'PROJ-222', { repos: 'demo\nweb\n' });
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-222');
      expect(opened.exitCode).toBe(0);
      expect(open.mock.calls.map((entry) => entry[0].project)).toEqual(['group/demo']);
      const body = await app.get(DocumentRepository).latestBody('PROJ-222', 'merge_request');
      expect(body).toContain('group/demo');
      expect(body).not.toContain('group/web');
    } finally {
      await app.close();
    }
  });

  it('fails with the host message when the host refuses the request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-refused-'));
    featureTree(root, 'PROJ-223');
    const find = jest.fn(async () => ({ record: null, httpCalls: [call('GET')] }));
    const open = jest.fn(async () => {
      throw new FetchFailed('Validation Failed: head is invalid', [call('POST', 422)]);
    });
    const app = await boot(root, { find, open }, jest.fn());
    try {
      await seed(app, 'PROJ-223');
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-223');
      expect(opened.exitCode).toBe(1);
      expect(opened.message).toContain('Validation Failed: head is invalid');
    } finally {
      await app.close();
    }
  });

  it('stops when a later commit is not pushed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-ahead-'));
    const tree = featureTree(root, 'PROJ-208');
    writeFileSync(join(tree, 'src', 'later.ts'), 'export const later = 1;\n');
    git(tree, ['add', 'src/later.ts']);
    git(tree, ['commit', '-m', 'later']);
    const find = jest.fn();
    const app = await boot(root, { find, open: jest.fn() }, jest.fn());
    try {
      await seed(app, 'PROJ-208');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-208');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('demo branch is not pushed');
      expect(find).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses main when the remote has no default branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-default-'));
    const tree = featureTree(root, 'PROJ-209');
    git(tree, ['remote', 'set-head', 'origin', '-d']);
    const open = jest.fn(async (_draft: MergeRequestDraft) => ({
      record: {
        project: 'group/demo',
        iid: 3,
        url: 'https://gitlab.example/group/demo/-/merge_requests/3',
        summary: '',
        draft: true,
      },
      httpCalls: [call('POST')],
    }));
    const app = await boot(
      root,
      { find: jest.fn(async () => ({ record: null, httpCalls: [call('GET')] })), open },
      jest.fn(async () => result('Fallback.\n')),
    );
    try {
      await seed(app, 'PROJ-209');
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-209');
      expect(opened.exitCode).toBe(0);
      expect(open.mock.calls[0]?.[0]?.target).toBe('main');
    } finally {
      await app.close();
    }
  });

  it('targets the branch the prompt names instead of the default branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-named-'));
    featureTree(root, 'PROJ-212');
    const open = jest.fn(async (_draft: MergeRequestDraft) => ({
      record: {
        project: 'group/demo',
        iid: 4,
        url: 'https://gitlab.example/group/demo/-/merge_requests/4',
        summary: '',
        draft: true,
      },
      httpCalls: [call('POST')],
    }));
    const app = await boot(
      root,
      { find: jest.fn(async () => ({ record: null, httpCalls: [call('GET')] })), open },
      jest.fn(async () => result('Named.\n')),
    );
    try {
      await seed(app, 'PROJ-212');
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-212');
      await runs.saveRun({ ...run!, prompt: 'Ship the field\nbranch: feature/PARENT-1-epic\n' });
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-212');
      expect(opened.exitCode).toBe(0);
      expect(open.mock.calls[0]?.[0]?.target).toBe('feature/PARENT-1-epic');
    } finally {
      await app.close();
    }
  });

  it('stops when the remote default branch is the feature branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-self-'));
    const tree = featureTree(root, 'PROJ-210');
    git(tree, ['remote', 'set-head', 'origin', 'feature/PROJ-210-ship-the-field']);
    const find = jest.fn();
    const app = await boot(root, { find, open: jest.fn() }, jest.fn());
    try {
      await seed(app, 'PROJ-210');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-210');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('target branch is the feature branch');
      expect(find).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('stops when the feature branch is not on origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-unpushed-'));
    featureTree(root, 'PROJ-203', 'demo', false);
    const find = jest.fn();
    const agent = jest.fn();
    const app = await boot(root, { find, open: jest.fn() }, agent);
    try {
      await seed(app, 'PROJ-203');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-203');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('demo branch is not pushed');
      expect(find).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('stops when origin is a different host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-host-'));
    const tree = featureTree(root, 'PROJ-204');
    git(tree, ['remote', 'set-url', 'origin', 'git@other.example:group/demo.git']);
    const find = jest.fn();
    const app = await boot(root, { find, open: jest.fn() }, jest.fn());
    try {
      await seed(app, 'PROJ-204');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-204');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('origin is not GITLAB_BASE_URL');
      expect(find).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('finishes when ci was skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-skip-'));
    const find = jest.fn();
    const open = jest.fn();
    const app = await boot(root, { find, open }, jest.fn());
    try {
      await seed(app, 'PROJ-206');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-206');
      if (!run) {
        throw new Error('run is missing');
      }
      await documents.putDocument(run, 'ci_skip', 'CI skipped: there is no origin to push.\n');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-206');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('CI skipped: there is no origin to push.');
      expect(find).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('names a missing token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-token-'));
    const app = await boot(root, { find: jest.fn(), open: jest.fn() }, jest.fn(), '');
    try {
      await seed(app, 'PROJ-205');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-205');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('GITLAB_TOKEN is missing');
    } finally {
      await app.close();
    }
  });

  it('keeps the gitlab call when the host rejects the request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-reject-'));
    featureTree(root, 'PROJ-207');
    const find = jest.fn(async () => {
      throw new FetchFailed('GITLAB_TOKEN was rejected', [call('GET', 401)]);
    });
    const app = await boot(root, { find, open: jest.fn() }, jest.fn());
    try {
      await seed(app, 'PROJ-207');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-207');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('GITLAB_TOKEN was rejected');
      const calls = await app.get<Repository<HttpCallEntity>>(getRepositoryToken(HttpCallEntity)).find();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).not.toContain(TOKEN);
    } finally {
      await app.close();
    }
  });
});
