import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DocumentRepository } from '../../history/document.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import type { MergeRequestDraft } from '../../integrations/code-host/code-host';
import { NOTHING_TO_MERGE } from './nothing-to-merge';
import { boot, call, featureTree, seed } from './merge-request.spec-helpers';

describe('merge-request step delivery', () => {
  it('a run over three projects that changes one passes with one merge request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-three-'));
    featureTree(root, 'PROJ-222', 'demo');
    featureTree(root, 'PROJ-222', 'web', false, false);
    featureTree(root, 'PROJ-222', 'api', false, false);
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
      await seed(app, 'PROJ-222', { repos: 'demo\nweb\napi\n', delivery: 'demo publishing\nweb read\napi read\n' });
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-222');
      expect(opened.exitCode).toBe(0);
      expect(opened.message).not.toContain('is not pushed');
      expect(open.mock.calls.map((entry) => entry[0].project)).toEqual(['group/demo']);
      const documents = app.get(DocumentRepository);
      const body = await documents.latestBody('PROJ-222', 'merge_request');
      expect(body).toContain('group/demo');
      expect(body).not.toContain('group/web');
      expect(await documents.latestBody('PROJ-222', 'delivery')).toBe(
        'demo published group/demo\nweb read\napi read\n',
      );
    } finally {
      await app.close();
    }
  });

  it('ends with nothing to merge and builds no tree when every repository is read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-allread-'));
    featureTree(root, 'PROJ-223', 'demo', false, false);
    featureTree(root, 'PROJ-223', 'web', false, false);
    const find = jest.fn();
    const open = jest.fn();
    const app = await boot(root, { find, open }, jest.fn());
    try {
      await seed(app, 'PROJ-223', { repos: 'demo\nweb\n', delivery: 'demo read\nweb read\n' });
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-223');
      expect(opened.exitCode).toBe(0);
      expect(opened.message).toContain(NOTHING_TO_MERGE);
      expect(find).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
