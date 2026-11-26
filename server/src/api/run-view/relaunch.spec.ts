import type { DocumentEntity, FlowEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { mergeHandoff } from '../../steps/shared/handoff';
import { openRelaunch, relaunchSteps, relaunchViews } from './relaunch';

const T = (minute: number): string => new Date(Date.parse('2026-11-22T01:00:00.000Z') + minute * 60_000).toISOString();

const row = (minute: number, phases: string[], fromStep: string, cause: string | null = 'rebase'): FlowEntity =>
  ({ phases: JSON.stringify(phases), fromStep, cause, createdAt: T(minute) }) as FlowEntity;
const ran = (step: string, finished: number): StepStatEntity => ({ step, finishedAt: T(finished) }) as StepStatEntity;
const handoff = (minute: number, note: string): DocumentEntity =>
  ({ kind: 'handoff', body: mergeHandoff(null, 'rebase', note), createdAt: T(minute) }) as DocumentEntity;

const subtask = { parentRunId: 4 } as RunEntity;
const alone = { parentRunId: null } as RunEntity;

describe('relaunchViews', () => {
  it('reads a subtask rebased onto its epic from its handoff note, with a capital letter', () => {
    const flows = [row(0, ['planning'], 'x', null), row(10, ['checks', 'ci'], 'checks')];
    const notes = [handoff(9, 'rebased onto the epic after input merged')];
    expect(relaunchViews(subtask, flows, [], notes)).toEqual([
      {
        at: T(10),
        reason: 'Rebased onto the epic after input merged',
        phases: ['checks', 'ci'],
        steps: ['checks', 'commit', 'merge-request', 'pipeline'],
        open: true,
      },
    ]);
  });

  it('reads the steps of a relaunch from its first step on', () => {
    const [view] = relaunchViews(alone, [row(10, ['ci'], 'commit')], [], []);
    expect(view.steps).toEqual(['commit', 'merge-request', 'pipeline']);
  });

  it('closes a relaunch once each of its steps ran after it, and not before', () => {
    const flows = [row(10, ['code-review', 'ci'], 'code-review')];
    const before = [ran('code-review', 5), ran('commit', 5), ran('merge-request', 5), ran('pipeline', 5)];
    const after = [ran('code-review', 12), ran('commit', 13), ran('merge-request', 14)];
    expect(relaunchViews(alone, flows, before, [])[0].open).toBe(true);
    expect(relaunchViews(alone, flows, after, [])[0].open).toBe(true);
    expect(relaunchViews(alone, flows, [...after, ran('pipeline', 15)], [])[0].open).toBe(false);
  });

  it('closes a relaunch when the run is done, and keeps only the latest one open', () => {
    const flows = [row(10, ['checks'], 'checks'), row(30, ['checks'], 'checks')];
    expect(relaunchViews(alone, flows, [], []).map((view) => view.open)).toEqual([false, true]);
    expect(relaunchViews({ ...alone, status: 'done' }, flows, [], []).map((view) => view.open)).toEqual([false, false]);
  });

  it('says where a run without a note was rebased onto', () => {
    const flows = [row(10, ['code-review', 'ci'], 'code-review')];
    expect(relaunchViews(alone, flows, [], [])[0].reason).toBe('Rebased onto main');
    expect(relaunchViews(subtask, flows, [], [])[0].reason).toBe('Rebased onto the epic');
  });

  it('takes each relaunch note from the newest handoff made before the next relaunch, the last one up to now', () => {
    const flows = [row(10, ['checks'], 'checks'), row(30, ['checks'], 'checks')];
    const notes = [
      handoff(9, 'rebased onto the epic after a merged'),
      handoff(35, 'rebased onto the epic after b merged'),
    ];
    expect(relaunchViews(subtask, flows, [], notes).map((view) => view.reason)).toEqual([
      'Rebased onto the epic after a merged',
      'Rebased onto the epic after b merged',
    ]);
  });

  it('leaves launches that are not a rebase out', () => {
    expect(relaunchViews(alone, [row(0, ['planning'], 'x', null)], [], [])).toEqual([]);
  });
});

describe('openRelaunch', () => {
  it('is the latest relaunch that is open', () => {
    const view = (at: string, open: boolean) => ({ at, open, reason: '', phases: [], steps: [] });
    expect(openRelaunch([view('a', true), view('b', false)])?.at).toBe('a');
    expect(openRelaunch([view('a', false)])).toBeUndefined();
  });
});

describe('relaunchSteps', () => {
  it('gives the steps still to run by run, only for the runs with an open relaunch', async () => {
    const flows = {
      listRebases: async () =>
        new Map([
          [7, [row(10, ['checks', 'ci'], 'checks')]],
          [8, [row(10, ['checks'], 'checks')]],
        ]),
    };
    const stats = new Map([
      [7, [ran('checks', 12)]],
      [8, [ran('checks', 12)]],
    ]);
    const steps = await relaunchSteps(flows, { listStats: async (id) => stats.get(id) ?? [] }, [7, 8, 9]);
    expect(steps).toEqual(new Map([[7, ['commit', 'merge-request', 'pipeline']]]));
  });
});
