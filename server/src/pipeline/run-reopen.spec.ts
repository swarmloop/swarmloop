import { storeRun } from '../testing/store-run.spec-helpers';
import { HostUnavailable } from '../core/swarmloop-error';
import type { PipelineResult } from '../core/pipeline-result';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import type { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { MergeRequestDrafts } from '../steps/merge-request/merge-request-draft';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { RunReopen } from './run-reopen';

const KEY = 'PROJ-1';
const ready = renderMergeRequest([
  { project: 'group/demo', iid: 7, url: 'https://code.example/demo/7', draft: false, summary: 'Ships the field.' },
]);

/** A code host that accepts every draft change. */
const registry = {
  byName: () => ({ setDraft: () => Promise.resolve({ httpCalls: [] }) }),
} as unknown as CodeHostRegistry;

describe('RunReopen', () => {
  async function setup(
    finish: (run: Awaited<ReturnType<RunRepository['openWaiting']>>) => void,
    hosts: CodeHostRegistry = registry,
  ) {
    const db = await repositoryDatabase();
    const runs = db.app.get(RunRepository);
    const documents = db.app.get(DocumentRepository);
    const run = await runs.openWaiting(KEY, '/target');
    run.codeHost = 'gitlab';
    finish(run);
    await storeRun(runs, run);
    await documents.putDocument(run, 'merge_request', ready);
    const started: string[] = [];
    const start = (key: string): Promise<PipelineResult> => {
      started.push(key);
      return Promise.resolve({ exitCode: 0, message: `${key} started` });
    };
    const reopen = new RunReopen(runs, new MergeRequestDrafts(hosts, documents));
    return { db, runs, documents, reopen, start, started };
  }

  it('puts the merge request back to draft, reopens the done run at plan-improve and starts the pipeline there', async () => {
    const { db, runs, documents, reopen, start, started } = await setup((run) =>
      writeRunState(run, { status: 'done', currentStep: 'done' }),
    );
    try {
      await reopen.reopen(KEY, start);
      const run = (await runs.findRun(KEY))!;
      expect([run.status, run.currentStep]).toEqual(['waiting', 'plan-improve']);
      expect(await documents.latestBody(KEY, 'merge_request')).toContain('draft: true');
      expect(started).toEqual([KEY]);
    } finally {
      await db.close();
    }
  });

  it('reopens the run and waits for the next try when the code host does not answer', async () => {
    const down = {
      byName: () => ({
        setDraft: () => Promise.reject(new HostUnavailable('gitlab', 'timeout', '2026-01-01T00:05:00.000Z')),
      }),
    } as unknown as CodeHostRegistry;
    const { db, runs, reopen, start, started } = await setup(
      (run) => writeRunState(run, { status: 'done', currentStep: 'done' }),
      down,
    );
    try {
      const result = await reopen.reopen(KEY, start);
      const run = (await runs.findRun(KEY))!;
      expect([run.status, run.currentStep]).toEqual(['waiting', 'plan-improve']);
      expect(storedState(run).reason).toMatchObject({ code: 'HOST_UNAVAILABLE', retryAt: '2026-01-01T00:05:00.000Z' });
      expect(result.exitCode).toBe(1);
      expect(started).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('leaves a merged run as it is', async () => {
    const { db, runs, documents, reopen, start, started } = await setup((run) =>
      writeRunState(run, {
        status: 'done',
        currentStep: 'done',
        merge: { merged: { demo: { sha: null, by: null, at: '2026-01-01T00:00:00.000Z', url: null } } },
      }),
    );
    try {
      await reopen.reopen(KEY, start);
      const run = (await runs.findRun(KEY))!;
      expect(storedState(run).state).toBe('merged');
      expect(run.currentStep).toBe('done');
      expect(await documents.latestBody(KEY, 'merge_request')).toContain('draft: false');
      expect(started).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('leaves a run that is not done as it is', async () => {
    const { db, runs, reopen, start, started } = await setup((run) =>
      writeRunState(run, { status: 'waiting', currentStep: 'checks' }),
    );
    try {
      await reopen.reopen(KEY, start);
      expect((await runs.findRun(KEY))?.currentStep).toBe('checks');
      expect(started).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
