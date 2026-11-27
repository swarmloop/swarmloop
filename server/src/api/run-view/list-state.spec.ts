import type { DocumentEntity, RunEntity } from '../../history/entities';
import { ERROR_CODES } from '../../contract/error-codes';
import { SUBTASKS_KIND } from '../../contract/subtask';
import { startWaitColumns, stateOfStatus, writeOpenItemState } from '../../history/run-state';
import { listPlans, listStates } from './list-state';
import { ownStates } from './own-state';
import { childrenByParent } from './status';

function run(id: number, key: string, extra: Partial<RunEntity> = {}): RunEntity {
  const row = { id, key, status: 'waiting', currentStep: 'implement', stateReason: null, ...extra } as RunEntity;
  return extra.state ? row : { ...row, ...stateOfStatus(row) };
}

/** A waiting run as its writer stores it when its documents hold an open question or an unsaved paste. */
function asking(id: number, key: string, extra: Partial<RunEntity> = {}): RunEntity {
  const row = run(id, key, extra);
  writeOpenItemState(row, { needsAnswers: true });
  return row;
}

function reason(code: string, extra: object = {}): string {
  return JSON.stringify({ code, message: 'm', ...extra });
}

function plan(...statuses: string[]): string {
  return JSON.stringify(statuses.map((status, index) => ({ id: `t${index + 1}`, title: 't', status })));
}

interface Setup {
  runs: RunEntity[];
  /** The latest plan of each run, by run key. */
  plans?: Record<string, string>;
  claimed?: string[];
  /** The run ids with a command that is accepted or executing and is not a stop. */
  queued?: number[];
}

/** The documents repository as the list reads it: the latest document of each asked kind of each asked run. */
function storedDocuments(runs: RunEntity[], plans: Record<string, string>) {
  const stored = [
    ...runs.flatMap((item) =>
      plans[item.key] ? [{ runId: item.id, kind: SUBTASKS_KIND, body: plans[item.key] }] : [],
    ),
  ] as DocumentEntity[];
  return {
    latestDocuments: async (runIds: number[], kinds: string[]) =>
      stored.filter((document) => runIds.includes(document.runId) && kinds.includes(document.kind)),
  };
}

async function states({ runs, plans = {}, claimed = [], queued = [] }: Setup) {
  const keys = new Map(runs.map((item) => [item.id, item.key]));
  const childrenOf = childrenByParent(runs);
  const stored = storedDocuments(runs, plans);
  const sources = {
    documents: stored,
    commands: { queuedRunIds: async (runIds: number[]) => new Set(runIds.filter((id) => queued.includes(id))) },
  };
  return listStates(
    runs,
    { keys, childrenOf, plans: await listPlans(stored, runs, childrenOf) },
    await ownStates(sources, runs, (key) => claimed.includes(key)),
  );
}

describe('listStates', () => {
  it('reads a waiting run with an open question as waiting for answers', async () => {
    const result = await states({
      runs: [asking(1, 'A-1', { currentStep: 'research' })],
    });
    expect(result['A-1']).toMatchObject({ state: 'waiting', stateReason: { code: 'NEEDS_ANSWERS' } });
  });

  it('keeps the open questions of one run from reaching another run', async () => {
    const result = await states({
      runs: [asking(1, 'A-1', { currentStep: 'research' }), run(2, 'A-2', { currentStep: 'research' })],
    });
    expect(result['A-1']?.stateReason?.code).toBe('NEEDS_ANSWERS');
    expect(result['A-2']?.stateReason?.code).not.toBe('NEEDS_ANSWERS');
  });

  it('waits for a paste at requirements until the pending one is saved', async () => {
    const asked = await states({ runs: [asking(1, 'A-1', { currentStep: 'requirements' })] });
    const saved = await states({ runs: [run(1, 'A-1', { currentStep: 'requirements' })] });
    expect(asked['A-1']?.stateReason?.code).toBe('NEEDS_ANSWERS');
    expect(saved['A-1']?.stateReason?.code).not.toBe('NEEDS_ANSWERS');
  });

  it('keeps the resume time of a limit wait', async () => {
    const limit = { runtime: 'x', resumesAt: '2026-11-13T10:00:00Z' };
    const result = await states({
      runs: [run(1, 'A-1', { stateReason: reason(ERROR_CODES.RUNTIME_LIMIT, { limit }) })],
    });
    expect(result['A-1']?.stateReason?.limit?.resumesAt).toBe(limit.resumesAt);
  });

  it('keeps the next try of a host outage', async () => {
    const retryAt = '2026-11-13T10:05:00Z';
    const result = await states({
      runs: [run(1, 'A-1', { stateReason: reason(ERROR_CODES.HOST_UNAVAILABLE, { retryAt }) })],
    });
    expect(result['A-1']?.stateReason?.retryAt).toBe(retryAt);
  });

  it('reads a merged run as merged', async () => {
    const mergeOutcome = JSON.stringify({ merged: {} });
    const result = await states({ runs: [run(1, 'A-1', { status: 'done', mergeOutcome })] });
    expect(result['A-1']?.state).toBe('merged');
  });

  it('reads a claimed run that is not done as running', async () => {
    const result = await states({ runs: [run(1, 'A-1')], claimed: ['A-1'] });
    expect(result['A-1']?.state).toBe('running');
  });

  it('lists a running run whose agent waits for a free place with the words of the wait', async () => {
    const place = 'Waiting for a free agent place (4 of 4 busy)';
    const waiting = { status: 'running', ...startWaitColumns({ code: 'AGENT_PLACE', message: place }) };
    const result = await states({
      runs: [run(1, 'A-1', waiting), run(2, 'B-1', { status: 'running', ...startWaitColumns(null) })],
      claimed: ['A-1', 'B-1'],
    });
    expect(result['A-1']).toMatchObject({ state: 'running', stateReason: { code: 'AGENT_PLACE', message: place } });
    expect(result['B-1']).toMatchObject({ state: 'running', stateReason: null });
  });

  it('a run with an accepted relaunch reads queued, and its task reads running', async () => {
    const parent = run(1, 'A-1', { stateReason: reason(ERROR_CODES.SUBTASKS_RUNNING) });
    const child = run(2, 'A-2', { parentRunId: 1, taskId: 't1' });
    const other = run(3, 'A-3', { parentRunId: 1, taskId: 't2' });
    const result = await states({
      runs: [parent, child, other],
      plans: { 'A-1': plan('waiting', 'waiting') },
      queued: [2],
    });
    expect(result['A-2']).toMatchObject({ state: 'queued', stateReason: null, task: { index: 0, status: 'running' } });
    expect(result['A-3']?.state).not.toBe('queued');
  });

  it('counts every task of the plan for a parent waiting for its subtasks, a task with no run as waiting', async () => {
    const parent = run(1, 'A-1', { stateReason: reason(ERROR_CODES.SUBTASKS_RUNNING) });
    const child = run(2, 'A-2', { status: 'running', parentRunId: 1, taskId: 't1' });
    const result = await states({ runs: [parent, child], plans: { 'A-1': plan('waiting', 'waiting', 'merged') } });
    expect(result['A-1']).toMatchObject({
      state: 'waiting',
      stateReason: { code: ERROR_CODES.SUBTASKS_RUNNING },
      taskCounts: { running: 1, waiting: 1, merged: 1 },
    });
  });

  it('counts every task of a parent that has no subtask run yet as waiting', async () => {
    const parent = run(1, 'A-1', { stateReason: reason(ERROR_CODES.SUBTASKS_RUNNING) });
    const result = await states({ runs: [parent], plans: { 'A-1': plan('waiting', 'waiting', 'waiting') } });
    expect(result['A-1']?.taskCounts).toEqual({ waiting: 3 });
  });

  it('gives no task counts to a finished run that has no subtask runs', async () => {
    const merged = run(1, 'A-1', { status: 'done', mergeOutcome: JSON.stringify({ merged: {} }) });
    const result = await states({ runs: [merged], plans: { 'A-1': plan('waiting', 'waiting') } });
    expect(result['A-1']).not.toHaveProperty('taskCounts');
  });

  it('gives a subtask its plan index and its own live status, not the stored copy of the parent', async () => {
    const parent = run(1, 'A-1', { stateReason: reason(ERROR_CODES.SUBTASKS_RUNNING) });
    const child = run(2, 'A-2', { status: 'running', parentRunId: 1, taskId: 't2' });
    const result = await states({ runs: [parent, child], plans: { 'A-1': plan('waiting', 'waiting') } });
    expect(result['A-2']?.task).toEqual({ index: 1, status: 'running' });
  });

  it('gives no task to a subtask whose id is not in the plan', async () => {
    const parent = run(1, 'A-1');
    const child = run(2, 'A-2', { status: 'running', parentRunId: 1, taskId: 'gone' });
    const result = await states({ runs: [parent, child], plans: { 'A-1': plan('waiting') } });
    expect(result['A-2']).not.toHaveProperty('task');
  });

  it('gives no task counts to a run with no plan', async () => {
    const result = await states({ runs: [run(1, 'A-1')] });
    expect(result['A-1']).not.toHaveProperty('taskCounts');
  });
});
