import type { DocumentEntity, RunEntity } from '../../history/entities';
import { ERROR_CODES } from '../../contract/error-codes';
import { SUBTASKS_KIND } from '../../contract/subtask';
import { listStates } from './list-state';

function run(id: number, key: string, extra: Partial<RunEntity> = {}): RunEntity {
  return { id, key, status: 'waiting', currentStep: 'implement', stateReason: null, ...extra } as RunEntity;
}

function reason(code: string, extra: object = {}): string {
  return JSON.stringify({ code, message: 'm', ...extra });
}

function plan(...statuses: string[]): string {
  return JSON.stringify(statuses.map((status, index) => ({ id: `t${index + 1}`, title: 't', status })));
}

interface Setup {
  runs: RunEntity[];
  plans?: Record<string, string>;
  documents?: Partial<DocumentEntity>[];
  claimed?: string[];
}

async function states({ runs, plans = {}, documents = [], claimed = [] }: Setup) {
  const keys = new Map(runs.map((item) => [item.id, item.key]));
  return listStates(
    {
      listDocuments: async () => documents as DocumentEntity[],
      latestBody: async (key: string, kind: string) => (kind === SUBTASKS_KIND ? (plans[key] ?? null) : null),
    },
    { listPastes: async () => [] },
    runs,
    keys,
    (key) => claimed.includes(key),
  );
}

describe('listStates', () => {
  it('reads a waiting run with an open question as waiting for answers', async () => {
    const result = await states({
      runs: [run(1, 'A-1', { currentStep: 'research' })],
      documents: [{ kind: 'questions', body: '- Which branch?\n' }],
    });
    expect(result['A-1']).toMatchObject({ state: 'waiting', stateReason: { code: 'NEEDS_ANSWERS' } });
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
