import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { REPORT_END, REPORT_START, reportOf } from '../shared/report-markers';
import { boot, call, featureTree, seed } from './merge-request.spec-helpers';

type Booted = Awaited<ReturnType<typeof boot>>;

async function storeParts(app: Booted, key: string): Promise<void> {
  const run = (await app.get(RunRepository).findRun(key))!;
  const notes = { requirements: 'a', quality: 'b', regressions: 'c', security: 'd', performance: 'e' };
  const parts = { line: 'The field ships.', done: ['x'], worthALook: [], notes, risk: 'low', riskReason: 'small' };
  await app.get(DocumentRepository).putDocument(run, 'review_report_result', JSON.stringify(parts));
}

describe('merge request report body', () => {
  it('opens a new request with the report between the markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-marked-'));
    featureTree(root, 'PROJ-240');
    const find = jest.fn(async () => ({ record: null, httpCalls: [call('GET')] }));
    const open = jest.fn(async (draft: { summary: string }) => ({
      record: {
        project: 'group/demo',
        iid: 5,
        url: 'https://gitlab.example/mr/5',
        summary: draft.summary,
        draft: true,
      },
      draftsUnavailable: false,
      httpCalls: [call('POST')],
    }));
    const app = await boot(root, { find, open }, jest.fn());
    try {
      await seed(app, 'PROJ-240');
      await storeParts(app, 'PROJ-240');
      await app.get(PipelineService).step('merge-request', 'PROJ-240');
      const sent = (open.mock.calls[0] as unknown as [{ summary: string }])[0].summary;
      expect(sent.startsWith(`${REPORT_START}\n## ⏳ Waiting for CI · risk: low\n> The field ships.`)).toBe(true);
      expect(sent.endsWith(REPORT_END)).toBe(true);
      const stored = await app.get(DocumentRepository).latestBody('PROJ-240', 'merge_request');
      expect(stored).toContain(REPORT_START);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the text of the host body outside the markers when it updates a request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-splice-'));
    featureTree(root, 'PROJ-241');
    const hostBody = `Template top\n\n${REPORT_START}\nold report\n${REPORT_END}\n\nA person wrote this.\n\nflaky: suite > case`;
    const find = jest.fn(async () => ({
      record: { project: 'group/demo', iid: 9, url: 'https://gitlab.example/mr/9', summary: hostBody, draft: true },
      httpCalls: [call('GET')],
    }));
    const update = jest.fn(async () => ({ httpCalls: [call('PUT')] }));
    const app = await boot(root, { find, open: jest.fn(), update }, jest.fn());
    try {
      await seed(app, 'PROJ-241');
      await storeParts(app, 'PROJ-241');
      await app.get(PipelineService).step('merge-request', 'PROJ-241');
      const sent = (update.mock.calls[0] as unknown as [string, number, string])[2];
      expect(sent.startsWith('Template top\n\n')).toBe(true);
      expect(sent.endsWith(`${REPORT_END}\n\nA person wrote this.\n\nflaky: suite > case`)).toBe(true);
      expect(reportOf(sent)).toContain('> The field ships.');
      expect(sent).not.toContain('old report');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
