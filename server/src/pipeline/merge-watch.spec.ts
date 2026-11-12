import 'reflect-metadata';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { REASON } from '../contract/run-state';
import { DocumentRepository } from '../history/document.repository';
import { EventRepository } from '../history/event.repository';
import { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { MergeRequestLookup } from '../steps/merge-request/merge-request-lookup';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { boot } from '../steps/prepare/prepare.step.spec-helpers';
import { MergeWatch } from './merge-watch';
import { ageRun, DAY_MS, seedRun } from './workspace.spec-helpers';

type State =
  | { state: 'open' }
  | { state: 'merged'; sha: string | null; by: string | null; at: string }
  | { state: 'closed'; by: string | null; at: string };
type Answer = State | Error;

describe('MergeWatch', () => {
  let app: TestingModule;
  let answers: Map<string, Answer>;
  let reads: number;

  beforeEach(async () => {
    const swarm = join(mkdtempSync(join(tmpdir(), 'swarmloop-merge-watch-')), 'swarm');
    mkdirSync(swarm);
    app = await boot(swarm);
    answers = new Map();
    reads = 0;
    jest.spyOn(app.get(MergeRequestLookup), 'state').mockImplementation((_host, project, iid) => {
      reads += 1;
      const answer = answers.get(`${project}#${iid}`) ?? new Error('no answer');
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ ...answer, httpCalls: [] });
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const table = () => app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity));
  const find = async (key: string) => (await app.get(RunRepository).findRun(key))!;

  /** A done run with one merge request per project. */
  async function doneRun(key: string, projects: string[], codeHost = 'github'): Promise<void> {
    await seedRun(app, key, 'done', 0);
    await table().update({ key }, { codeHost });
    const records = projects.map((project, index) => ({
      project,
      iid: index + 1,
      url: `https://github.com/${project}/pull/${index + 1}`,
      draft: false,
      summary: '',
    }));
    await app.get(DocumentRepository).putDocument(await find(key), 'merge_request', renderMergeRequest(records));
  }

  const merged = (by: string | null, sha = 'abc'): State => ({
    state: 'merged',
    sha,
    by,
    at: '2026-05-01T10:00:00Z',
  });

  it('turns a done run into merged with the sha, who merged it and when, whoever merged it', async () => {
    await doneRun('PROJ-1', ['acme/demo']);
    answers.set('acme/demo#1', merged('someone-else'));

    await app.get(MergeWatch).run();

    const run = await find('PROJ-1');
    expect(run.state).toBe('merged');
    expect(run.status).toBe('done');
    expect(JSON.parse(run.mergeOutcome!)).toEqual({
      merged: {
        'acme/demo': {
          sha: 'abc',
          by: 'someone-else',
          at: '2026-05-01T10:00:00Z',
          url: 'https://github.com/acme/demo/commit/abc',
        },
      },
    });
  });

  it('links the merge commit on a GitLab host', async () => {
    await doneRun('PROJ-1G', ['group/demo'], 'gitlab');
    await app.get(DocumentRepository).putDocument(
      await find('PROJ-1G'),
      'merge_request',
      renderMergeRequest([
        {
          project: 'group/demo',
          iid: 1,
          url: 'https://gitlab.com/group/demo/-/merge_requests/1',
          draft: false,
          summary: '',
        },
      ]),
    );
    answers.set('group/demo#1', merged('ada'));

    await app.get(MergeWatch).run();

    const merge = JSON.parse((await find('PROJ-1G')).mergeOutcome!);
    expect(merge.merged['group/demo'].url).toBe('https://gitlab.com/group/demo/-/commit/abc');
  });

  it('turns a done run into closed when its merge request was closed without a merge', async () => {
    await doneRun('PROJ-2', ['acme/demo']);
    answers.set('acme/demo#1', { state: 'closed', by: 'grace', at: '2026-05-02T08:00:00Z' });

    await app.get(MergeWatch).run();

    const run = await find('PROJ-2');
    expect(run.state).toBe('closed');
    expect(JSON.parse(run.mergeOutcome!)).toEqual({
      closed: { repo: 'acme/demo', by: 'grace', at: '2026-05-02T08:00:00Z' },
    });
  });

  it('merges a two-repository run only when both are merged, and closes it when either is closed', async () => {
    await doneRun('PROJ-3', ['acme/api', 'acme/web']);
    answers.set('acme/api#1', merged('ada', 'a1'));
    answers.set('acme/web#2', { state: 'open' });

    await app.get(MergeWatch).run();
    expect((await find('PROJ-3')).state).toBe('done');

    answers.set('acme/web#2', merged('ada', 'b2'));
    await app.get(MergeWatch).run();
    const run = await find('PROJ-3');
    expect(run.state).toBe('merged');
    expect(Object.keys(JSON.parse(run.mergeOutcome!).merged)).toEqual(['acme/api', 'acme/web']);

    await doneRun('PROJ-4', ['acme/api', 'acme/web']);
    answers.set('acme/api#1', merged('ada'));
    answers.set('acme/web#2', { state: 'closed', by: null, at: '2026-05-02T08:00:00Z' });
    await app.get(MergeWatch).run();
    expect((await find('PROJ-4')).state).toBe('closed');
  });

  it('keeps the run done with a note when the host fails, never fails it, and retries on the next pass', async () => {
    await doneRun('PROJ-5', ['acme/demo']);

    await app.get(MergeWatch).run();
    const noted = await find('PROJ-5');
    expect(noted.status).toBe('done');
    expect(noted.state).toBe('done');
    expect(JSON.parse(noted.stateReason!).code).toBe(REASON.mergeWatchUnavailable);

    await app.get(MergeWatch).run();
    expect((await find('PROJ-5')).revision).toBe(noted.revision);

    answers.set('acme/demo#1', merged('ada'));
    await app.get(MergeWatch).run();
    expect((await find('PROJ-5')).state).toBe('merged');
  });

  it('leaves a run without a code host done with the note', async () => {
    await doneRun('PROJ-6', ['acme/demo'], '');

    await app.get(MergeWatch).run();

    const run = await find('PROJ-6');
    expect(run.state).toBe('done');
    expect(JSON.parse(run.stateReason!).code).toBe(REASON.mergeWatchUnavailable);
  });

  it('stops reading a run after 30 days and keeps a note', async () => {
    await doneRun('PROJ-7', ['acme/demo']);
    answers.set('acme/demo#1', { state: 'open' });
    await app.get(MergeWatch).run();
    await table().update({ key: 'PROJ-7' }, { doneAt: new Date(Date.now() - 31 * DAY_MS).toISOString() });
    const before = reads;

    await app.get(MergeWatch).run();
    await app.get(MergeWatch).run();

    expect(reads).toBe(before);
    const run = await find('PROJ-7');
    expect(run.state).toBe('done');
    expect(JSON.parse(run.stateReason!).code).toBe(REASON.mergeWatchStopped);
  });

  it('keeps the original done time through a host that fails and recovers, so retention ages the run from it', async () => {
    await doneRun('PROJ-12', ['acme/demo']);
    await ageRun(app, 'PROJ-12', 'done', 40);
    const first = (await find('PROJ-12')).updatedAt;

    await app.get(MergeWatch).run();
    answers.set('acme/demo#1', { state: 'open' });
    await app.get(MergeWatch).run();
    answers.delete('acme/demo#1');
    await app.get(MergeWatch).run();

    expect((await find('PROJ-12')).doneAt).toBe(first);
  });

  it('counts the time to merge from when the run was first seen done, and does not touch runs that are not done', async () => {
    await doneRun('PROJ-8', ['acme/demo']);
    await ageRun(app, 'PROJ-8', 'done', 2);
    answers.set('acme/demo#1', { state: 'open' });
    await seedRun(app, 'PROJ-9', 'blocked', 0);

    await app.get(MergeWatch).run();

    const run = await find('PROJ-8');
    expect(Date.now() - Date.parse(run.doneAt!)).toBeGreaterThan(1.9 * DAY_MS);
    expect((await find('PROJ-9')).doneAt).toBeNull();
  });

  /** A run that is not done, with one merge request per project. */
  async function unfinishedRun(key: string, status: string, state: string, projects: string[]): Promise<void> {
    await doneRun(key, projects);
    await table().update({ key }, { status, state, doneAt: null, mergeOutcome: null });
  }

  const loops = async (key: string) => app.get(EventRepository).listLoops((await find(key)).id);

  it('turns a stopped run whose only request was merged into done, merged, and says so in its history', async () => {
    await unfinishedRun('PROJ-10', 'failed', 'stopped', ['acme/demo']);
    answers.set('acme/demo#1', merged('queue'));

    await app.get(MergeWatch).run();

    const run = await find('PROJ-10');
    expect([run.status, run.state]).toEqual(['done', 'merged']);
    expect(Object.keys(JSON.parse(run.mergeOutcome!).merged)).toEqual(['acme/demo']);
    expect((await loops('PROJ-10')).map((loop) => [loop.counter, loop.reason])).toEqual([
      ['merge-watch', 'The merge request was merged on GitHub while the run was stopped; the run is done.'],
    ]);
  });

  it('leaves a blocked run with one request merged and one open as it is', async () => {
    await unfinishedRun('PROJ-11', 'blocked', 'blocked', ['acme/one', 'acme/two']);
    answers.set('acme/one#1', merged('queue'));
    answers.set('acme/two#2', { state: 'open' });
    const before = await find('PROJ-11');

    await app.get(MergeWatch).run();

    const run = await find('PROJ-11');
    expect([run.status, run.state, run.stateReason, run.mergeOutcome, run.revision]).toEqual([
      'blocked',
      'blocked',
      before.stateReason,
      null,
      before.revision,
    ]);
    expect(await loops('PROJ-11')).toEqual([]);
  });

  it('keeps a stopped run while another request is open even if one was closed', async () => {
    await unfinishedRun('PROJ-12', 'failed', 'stopped', ['acme/one', 'acme/two']);
    answers.set('acme/one#1', { state: 'closed', by: 'grace', at: '2026-05-02T08:00:00Z' });
    answers.set('acme/two#2', { state: 'open' });

    await app.get(MergeWatch).run();

    expect((await find('PROJ-12')).status).toBe('failed');
  });

  it('turns a waiting run whose request was closed into done, closed', async () => {
    await unfinishedRun('PROJ-13', 'waiting', 'waiting', ['acme/demo']);
    answers.set('acme/demo#1', { state: 'closed', by: 'grace', at: '2026-05-02T08:00:00Z' });

    await app.get(MergeWatch).run();

    const run = await find('PROJ-13');
    expect([run.status, run.state]).toEqual(['done', 'closed']);
    expect((await loops('PROJ-13'))[0].reason).toContain('closed on GitHub while the run was waiting');
  });

  it('leaves a running run with a merged request alone', async () => {
    await unfinishedRun('PROJ-14', 'running', 'running', ['acme/demo']);
    answers.set('acme/demo#1', merged('queue'));

    await app.get(MergeWatch).run();

    expect((await find('PROJ-14')).status).toBe('running');
    expect(reads).toBe(0);
  });
});
