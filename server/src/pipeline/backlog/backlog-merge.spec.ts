import type { PipelineCheck } from '../../integrations/code-host/code-host';
import { backlogHarness } from './backlog.spec-helpers';

type Harness = Awaited<ReturnType<typeof backlogHarness>>;

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await backlogHarness();
  try {
    await body(harness);
  } finally {
    await harness.scheduler().onModuleDestroy();
    await harness.db.close();
  }
}

function failed(name: string, status: PipelineCheck['status']): PipelineCheck {
  return { id: 1, name, app: '', status, durationMs: 1, url: '', summary: '', annotations: [], workflow: true };
}

/** A backlog with a task whose run is done with one request on web (iid 5). */
async function doneTask(h: Harness, options: { mergeMode?: 'green' | 'ok'; manual?: boolean } = {}) {
  h.setMain('web');
  const backlog = await h.seedBacklog('one', { mergeMode: options.mergeMode });
  const id = backlog.id as number;
  const milestone = await h.seedMilestone(id, 1);
  await h.seedTask(id, 'a', { milestoneId: milestone.id as number, runKey: 'a-1', manual: options.manual ?? false });
  await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);
  return id;
}

const mergeCalls = (h: Harness) => h.fake.calls.filter((call) => call.name === 'mergeMergeRequest');

describe('BacklogMerge', () => {
  it('merges a clean request on a green main, keeps the commit and clears the note', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({
        status: 'merged',
        note: '',
        merged: { web: 'acme/web-merge-1' },
      });
      expect(mergeCalls(h)[0].args).toEqual(['acme/web', 5, 'acme/web-pr-5', { method: 'squash' }]);
    }));

  it('waits for a draft and for unknown mergeability', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.fake.setGate('acme/web', 5, { draft: true });
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('waits for its merge request to leave draft');
      h.fake.setGate('acme/web', 5, { draft: false, mergeability: 'unknown' });
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('waits for the host to tell whether it merges');
      expect(mergeCalls(h)).toHaveLength(0);
    }));

  it('asks for one rebase per head, then needs a person', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.fake.setGate('acme/web', 5, { mergeability: 'behind' });
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('rebased onto swarmloop/web; waits for its new head');
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('still behind swarmloop/web after a rebase; needs a person');
      expect(h.accepts).toEqual([{ type: 'rebase', key: 'a-1', idempotencyKey: 'backlog-rebase-a-acme/web-pr-5' }]);
      h.fake.setGate('acme/web', 5, { head: 'newer' });
      await h.tick();
      expect(h.accepts).toHaveLength(2);
    }));

  it('names failing checks, then pending checks, then the reviews', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.fake.setGate('acme/web', 5, { mergeability: 'blocked', blockedBy: 'review required' });
      h.fake.setChecks('acme/web', 5, [failed('lint', 'failed'), failed('e2e', 'running')]);
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('checks failing: lint; needs a person');
      h.fake.setChecks('acme/web', 5, [failed('e2e', 'running')]);
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('checks pending: e2e; needs a person');
      h.fake.setChecks('acme/web', 5, []);
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('reviews: review required; needs a person');
    }));

  it('waits for the owner in mode ok and for a manual task until the OK is given', () =>
    withHarness(async (h) => {
      const id = await doneTask(h, { mergeMode: 'ok' });
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('waits for your OK to merge');
      await h.backlogs.saveTask({ ...(await h.task(id, 'a')), mergeOk: true });
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({ status: 'merged' });
    }));

  it('waits for the owner for a manual task in mode green', () =>
    withHarness(async (h) => {
      const id = await doneTask(h, { manual: true });
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('waits for your OK to merge');
      expect(mergeCalls(h)).toHaveLength(0);
    }));

  it('waits for a red main, but merges the task that fixes it', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.setMain('web', 'red');
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('waits for a green main of web');
      await h.backlogs.saveTask({ ...(await h.task(id, 'a')), fixesMain: 'web' });
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({ status: 'merged' });
    }));

  it('shows a request closed without a merge, from the gate and from a run MergeWatch closed', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.fake.setGate('acme/web', 5, { state: 'closed' });
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('its merge request was closed without a merge');
      await h.seedTask(id, 'b', { runKey: 'b-1' });
      await h.seedDoneRun('b-1', [{ repo: 'web', iid: 6 }], { closed: { repo: 'acme/web', by: null, at: '' } });
      const before = h.fake.calls.length;
      await h.tick();
      expect((await h.task(id, 'b')).note).toBe('its merge request was closed without a merge');
      expect(h.fake.calls.slice(before).some((call) => call.args[1] === 6)).toBe(false);
    }));

  it('makes a task merged from a run MergeWatch merged, with its commits and no host call', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      const at = '2026-11-12T10:00:00Z';
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }], {
        merged: { 'acme/web': { sha: 'abc', by: 'bob', at, url: null } },
      });
      h.fake.calls.length = 0;
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({ status: 'merged', merged: { web: 'abc' } });
      expect(h.fake.calls).toEqual([]);
    }));

  it('notes a done run without a merge request', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('its run is done without a merge request; needs a person');
    }));

  it('shows a refused merge and a refused rebase as waits, each event written once', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.fake.refuseMerge('acme/web', 5, 'branch protected');
      await h.tick();
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('merge refused by the host: branch protected');
      expect(await h.backlogs.recordEvent(id, 'merge-refused:a:web:acme/web-pr-5', 'merge-refused', {})).toBe(false);
      h.fake.refuseMerge('acme/web', 5, null);
      h.fake.setGate('acme/web', 5, { mergeability: 'behind' });
      h.refuseRebase('run is busy');
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('rebase refused: run is busy');
      expect(await h.backlogs.recordEvent(id, 'rebase-refused:a:acme/web-pr-5', 'rebase-refused', {})).toBe(false);
    }));

  it('asks for the rebase when the merge conflicts', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.fake.conflictMerge('acme/web', 5, 'conflict');
      await h.tick();
      expect((await h.task(id, 'a')).note).toBe('rebased onto swarmloop/web; waits for its new head');
      expect(h.accepts).toHaveLength(1);
    }));

  it('waits with the next try when the host does not answer', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.fake.hostDown('2026-11-12T11:00:00Z');
      await h.tick();
      expect((await h.task(id, 'a')).note).toContain('next try at 2026-11-12T11:00:00Z');
    }));

  it('records a merge that was in flight before a restart without merging again', () =>
    withHarness(async (h) => {
      const id = await doneTask(h);
      h.fake.setGate('acme/web', 5, { state: 'merged', sha: 'landed' });
      h.restart();
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({ status: 'merged', merged: { web: 'landed' } });
      expect(mergeCalls(h)).toHaveLength(0);
    }));

  it('merges nothing of a paused backlog', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const backlog = await h.seedBacklog('one', { paused: true });
      const id = backlog.id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({ merged: {} });
      expect(h.fake.calls).toEqual([]);
    }));

  it('follows a task that has no milestone, and holds the next task of the repository on a pending main', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'item', { runKey: 'item-1', milestoneId: null });
      await h.seedTask(id, 'other', { runKey: 'other-1', milestoneId: null });
      await h.seedDoneRun('item-1', [{ repo: 'web', iid: 7 }]);
      await h.seedDoneRun('other-1', [{ repo: 'web', iid: 8 }]);
      await h.tick();
      expect(await h.task(id, 'item')).toMatchObject({ status: 'merged', merged: { web: 'acme/web-merge-1' } });
      expect(await h.task(id, 'other')).toMatchObject({ merged: {}, note: 'waits for a green main of web' });
    }));

  it('merges a task over two repositories in one repository and then the other', () =>
    withHarness(async (h) => {
      h.setMain('web');
      h.setMain('server');
      const id = (await h.seedBacklog('one', { repositories: ['web', 'server'] })).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1', repositories: ['web', 'server'] });
      await h.seedDoneRun('a-1', [
        { repo: 'web', iid: 5 },
        { repo: 'server', iid: 6 },
      ]);
      h.fake.setGate('acme/server', 6, { draft: true });
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({
        status: 'green',
        merged: { web: 'acme/web-merge-1' },
        note: 'waits for its merge request to leave draft',
      });
      h.fake.setGate('acme/server', 6, { draft: false });
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({
        status: 'merged',
        merged: { web: 'acme/web-merge-1', server: 'acme/server-merge-1' },
        note: '',
      });
      expect(mergeCalls(h)).toHaveLength(2);
    }));
});
