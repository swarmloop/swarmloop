import { ConflictException } from '@nestjs/common';
import { RunRebase } from './run-rebase';
import { actionsFor, REASON, type RunState } from '../contract/run-state';
import { storedState, writeRunState } from '../history/run-state';
import { HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import type { RunEntity } from '../history/entities';
import { rebaseFeatureRepos } from '../git/rebase';
import { ARTIFACTS } from './contract/artifacts';

jest.mock('../git/rebase', () => ({ rebaseFeatureRepos: jest.fn(), completeRebase: async () => undefined }));
jest.mock('../git/worktree-lock', () => ({ withWorktrees: (_paths: string[], fn: () => unknown) => fn() }));
jest.mock('../git/repo-names', () => ({
  ...jest.requireActual('../git/repo-names'),
  mountsForStep: () => [],
}));
jest.mock('../git/git', () => ({ git: async () => 'same-head' }));
jest.mock('./shared/rebase-journal', () => ({ runJournal: () => ({}) }));
jest.mock('./shared/base-tips', () => ({
  BaseTips: class {
    known = async () => ({});
    recordMoved = async () => undefined;
  },
}));
jest.mock('./shared/gate', () => ({
  ...jest.requireActual('./shared/gate'),
  worktreesFingerprint: async () => 'moved-tree',
}));

const PAST_GUARD = 'past the guard';
const SUBTASK_BLOCKED = 'SUBTASK_BLOCKED';

/** Each state a stored run can derive to without extra facts, with the stored row that gives it. */
const ROWS: {
  state: RunState;
  status: string;
  code?: string;
  merge?: { closed: { repo: string; by: null; at: string } };
}[] = [
  { state: 'idle', status: 'waiting' },
  { state: 'running', status: 'running' },
  { state: 'waiting', status: 'waiting', code: 'RUNTIME_LIMIT' },
  { state: 'stopped', status: 'blocked', code: REASON.stopped },
  { state: 'stopped', status: 'failed', code: REASON.stopped },
  { state: 'blocked', status: 'blocked', code: REASON.ciNotRun },
  { state: 'blocked', status: 'blocked' },
  { state: 'failed', status: 'failed' },
  { state: 'done', status: 'done' },
  { state: 'closed', status: 'done', merge: { closed: { repo: 'demo', by: null, at: '2026-11-11' } } },
];

function rebaseOf(run: RunEntity, backToDraft: () => Promise<void> = async () => undefined): RunRebase {
  const runs = {
    findRun: async () => run,
    children: async () => [],
    held: () => false,
    bumpGeneration: async () => {
      throw new Error(PAST_GUARD);
    },
  };
  const drafts = { backToDraft };
  return new RunRebase(
    runs as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    drafts as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function runOf(row: (typeof ROWS)[number]): RunEntity {
  const run = {
    key: 'f36-1',
    split: false,
    currentStep: 'implement',
    stateReason: null,
    mergeOutcome: null,
  } as unknown as RunEntity;
  writeRunState(run, {
    status: row.status,
    currentStep: 'implement',
    reason: row.code ? { code: row.code, message: 'why' } : undefined,
    merge: row.merge,
  });
  return run;
}

describe('run rebase', () => {
  it.each([
    ['a blocked subtask the parent moves', { parentRunId: 7 }, true, PAST_GUARD],
    ['a working subtask the parent moves', { parentRunId: 7 }, true, PAST_GUARD],
    ['a blocked subtask a person moves', { parentRunId: 7 }, false, 'f36-1 is blocked'],
    ['a blocked run that is no subtask', { parentRunId: null }, true, 'f36-1 is blocked'],
  ])('takes %s only as the parent sends it', async (name, link, byParent, outcome) => {
    const run = { ...runOf({ state: 'blocked', status: 'blocked' }), ...link };
    if (name.includes('working')) writeRunState(run, { status: 'running', currentStep: 'implement' });

    await expect(rebaseOf(run).rebase('f36-1', false, byParent)).rejects.toThrow(outcome);
  });

  it.each(ROWS)('follows what actionsFor offers for $status run in state $state', async (row) => {
    const run = runOf(row);
    const { state, reason } = storedState(run);
    expect(state).toBe(row.state);
    const offered = actionsFor(state, reason?.code ?? null).includes('rebase');
    const rebase = rebaseOf(run).rebase('f36-1');
    if (offered) {
      await expect(rebase).rejects.toThrow(PAST_GUARD);
    } else {
      await expect(rebase).rejects.toThrow(new ConflictException(`f36-1 is ${state}`).message);
    }
  });

  it.each([
    ['a split epic blocked by a subtask', { split: true }, SUBTASK_BLOCKED, true, PAST_GUARD],
    [
      'a split epic blocked by a subtask, sent by a person',
      { split: true },
      SUBTASK_BLOCKED,
      false,
      'f36-1 is blocked',
    ],
    ['a blocked run that is not split', { split: false }, SUBTASK_BLOCKED, true, 'f36-1 is blocked'],
    ['a split epic blocked for another reason', { split: true }, REASON.ciNotRun, true, 'f36-1 is blocked'],
  ])('takes a main move of %s', async (_name, link, code, byMain, outcome) => {
    const run = { ...runOf({ state: 'blocked', status: 'blocked', code }), ...link };
    await expect(rebaseOf(run).rebase('f36-1', false, false, byMain)).rejects.toThrow(outcome);
  });

  it('refuses a main move of an epic that runs', async () => {
    const run = { ...runOf({ state: 'running', status: 'running' }), split: true };
    await expect(rebaseOf(run).rebase('f36-1', false, false, true)).rejects.toThrow('f36-1 is running');
  });

  it('rebases a stopped run, which Rebase is offered to', async () => {
    const run = runOf({ state: 'stopped', status: 'blocked', code: REASON.stopped });
    await expect(rebaseOf(run).rebase('f36-1')).rejects.toThrow(PAST_GUARD);
  });

  it('lets an outage of the host through when the merge request goes back to draft', async () => {
    const run = runOf({ state: 'stopped', status: 'blocked', code: REASON.stopped });
    const outage = new HostUnavailable('api.github.com', 'HTTP 503', '2026-11-12T15:00:00.000Z');
    await expect(rebaseOf(run, () => Promise.reject(outage)).rebase('f36-1')).rejects.toBe(outage);
  });

  it('turns any other error of the draft call into a conflict', async () => {
    const run = runOf({ state: 'stopped', status: 'blocked', code: REASON.stopped });
    const refused = () => Promise.reject(new SwarmloopError('draft refused'));
    await expect(rebaseOf(run, refused).rebase('f36-1')).rejects.toThrow(
      new ConflictException('draft refused').message,
    );
  });
});

/** A rebase whose move ends as `stop`, over fakes that record the documents, the stamps and where the run was started. */
function movingRun(currentStep: string, status: string, stop: 'clean' | 'conflict') {
  const run = { key: 'f36-1', split: false, generation: 1, currentStep, mergeOutcome: null } as unknown as RunEntity;
  writeRunState(run, { status, currentStep });
  const bodies: Record<string, string> = {
    [ARTIFACTS.repos.kind]: 'demo',
    [ARTIFACTS.requirements.kind]: 'req',
    [ARTIFACTS.implementation.kind]: 'notes',
  };
  const seen = { documents: [] as [string, string][], stamps: [] as unknown[], flow: [] as unknown[] };
  jest
    .mocked(rebaseFeatureRepos)
    .mockResolvedValue(
      stop === 'clean'
        ? { kind: 'clean', leases: [] }
        : { kind: 'conflict', repo: 'demo', files: [], stderr: '', base: 'b', commit: 'c' },
    );
  const runs = {
    findRun: async () => run,
    children: async () => [],
    held: () => false,
    bumpGeneration: async () => void (run.generation += 1),
    change: async (_key: string, change: (fresh: RunEntity) => void) => change(run),
  };
  const documents = {
    latestBody: async (_key: string, kind: string) => bodies[kind] ?? null,
    putDocument: async (_run: RunEntity, kind: string, body: string) => void seen.documents.push([kind, body]),
    stampLatest: async (_run: RunEntity, kind: string, stamp: unknown) => void seen.stamps.push([kind, stamp]),
  };
  const flows = {
    activePhases: async () => ['checks'],
    noteFlow: async (...args: unknown[]) => void seen.flow.push(args),
  };
  const rebase = new RunRebase(
    runs as never,
    documents as never,
    flows as never,
    { env: {} } as never,
    {} as never,
    { refreshAfterRebase: async () => undefined },
    { backToDraft: async () => undefined } as never,
    { tokensFor: async () => ({}) } as never,
    { branchOf: async () => 'feature/x', commitMessageOf: async () => 'msg' } as never,
    { of: async () => ({}) } as never,
    {} as never,
  );
  return { rebase, run, seen };
}

describe('run rebase outcomes', () => {
  it('a clean move of a run past review starts at checks with its review gate counted on the new head', async () => {
    const { rebase, run, seen } = movingRun('pipeline', 'waiting', 'clean');

    expect(await rebase.rebase('f36-1', false, false, false, false, null)).toBe('start');

    expect(seen.stamps).toEqual([[ARTIFACTS.reviewReport.kind, { generation: 2, fingerprint: 'moved-tree' }]]);
    expect(run.currentStep).toBe('checks');
    expect(seen.flow).toEqual([['f36-1', ['checks', 'ci'], 'checks', 'rebase']]);
  });

  it('a clean move of a done run starts at checks', async () => {
    const { rebase, run, seen } = movingRun('commit', 'done', 'clean');
    run.mergeOutcome = null;

    expect(await rebase.rebase('f36-1', false, false, false, false, null)).toBe('start');

    expect(seen.documents).toContainEqual([ARTIFACTS.rebaseMergeSkip.kind, 'skip\n']);
    expect(run.currentStep).toBe('checks');
  });

  it('resumes a clean move of a run that is still before review', async () => {
    const { rebase, seen } = movingRun('code-review', 'waiting', 'clean');

    expect(await rebase.rebase('f36-1', false, false, false, false, null)).toBe('resume');
    expect(seen.stamps).toEqual([]);
  });

  it('a move with a conflict starts at implement', async () => {
    const { rebase, run, seen } = movingRun('pipeline', 'waiting', 'conflict');

    expect(await rebase.rebase('f36-1', false, false, false, false, null)).toBe('resolve');

    expect(run.currentStep).toBe('implement');
    expect(seen.documents).toContainEqual([ARTIFACTS.rebaseConflict.kind, 'pending\n']);
    expect(seen.stamps).toEqual([]);
  });

  it.each([
    ['the host text', 'CONFLICT in a.txt', 'CONFLICT in a.txt'],
    ['that the host gave no reason', '  \n', 'the code host reported a conflict and gave no reason'],
  ])('hands the conflict agent the host text, or says the host gave no reason (%s)', async (_name, text, said) => {
    const { rebase, run, seen } = movingRun('pipeline', 'waiting', 'clean');

    expect(await rebase.rebase('f36-1', false, false, false, false, text)).toBe('resolve');

    expect(seen.documents).toContainEqual([ARTIFACTS.rebaseConflict.kind, `pending\nhost-conflict\n${said}\n`]);
    expect(run.currentStep).toBe('implement');
  });
});
