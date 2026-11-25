import type { StatsRows, StatsRunRow } from '../history/stats.repository';
import { buildStats } from './stats';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const START = '2026-11-10T08:00:00.000Z';
const NO_PERSON: StatsRows['person'] = { answers: [], planChats: [], backlogMessages: [] };

function run(id: number, extra: Partial<StatsRunRow> = {}): StatsRunRow {
  return { id, key: `run-${id}`, prompt: null, status: 'done', runtime: 'claude', createdAt: START, ...extra };
}

function spend(runId: number, usd: number): StatsRows['steps'][number] {
  return {
    runId,
    step: 'implement',
    runtime: null,
    model: 'model-a',
    effort: null,
    status: 'done',
    killReason: null,
    usd,
    tokensIn: 10,
    tokensOut: 1,
    durationMs: 1000,
    finishedAt: START,
    shellEdits: 0,
  };
}

function view(runs: StatsRunRow[], costs: [number, number][], times: [number, number][] = []) {
  const rows: StatsRows = {
    firstRunAt: START,
    runs,
    steps: costs.map(([id, usd]) => spend(id, usd)),
    loops: [],
    stalls: [],
    person: NO_PERSON,
  };
  return buildStats(rows, new Map(times), NOW, { days: 7, tzOffset: 0 });
}

describe('epics and tasks', () => {
  const merged = { state: 'merged' };
  const runs = [
    run(1, { ...merged, doneAt: '2026-11-10T10:00:00.000Z' }),
    run(2, { parentRunId: 1, ...merged }),
    run(3, { parentRunId: 1, ...merged }),
    run(4, { parentRunId: 1, status: 'failed' }),
    run(5, merged),
    run(6, { state: 'closed' }),
    run(7, { status: 'running' }),
  ];
  const costs: [number, number][] = [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 5],
    [6, 6],
    [7, 7],
  ];
  const times: [number, number][] = [
    [2, 600_000],
    [3, 1_200_000],
    [4, 1_800_000],
    [5, 60_000],
    [6, 120_000],
  ];

  it('counts a run with subtasks as one epic: its cost is the runs together, its time runs from start to done', () => {
    const { epics } = view(runs, costs, times);

    expect(epics).toEqual({
      finished: 1,
      active: 0,
      failed: 0,
      medianUsd: 10,
      medianMs: 7_200_000,
      back: 0,
      medianReturns: 0,
    });
  });

  it('counts a run without subtasks as a task, alone or a subtask, by its outcome with its own cost and time', () => {
    const { tasks } = view(runs, costs, times);

    expect(tasks).toMatchObject({ finished: 4, active: 1, failed: 1, medianUsd: 4, medianMs: 360_000 });
  });

  it('lists the subtasks as task rows with their own figures, and marks each run as an epic or a task', () => {
    const stats = view(runs, costs, times);

    expect(stats.subtasks.map(({ key, kind, usd, durationMs }) => [key, kind, usd, durationMs])).toEqual([
      ['run-2', 'task', 2, 600_000],
      ['run-3', 'task', 3, 1_200_000],
      ['run-4', 'task', 4, 1_800_000],
    ]);
    expect(stats.runs.map(({ key, kind }) => [key, kind])).toEqual([
      ['run-1', 'epic'],
      ['run-5', 'task'],
      ['run-6', 'task'],
      ['run-7', 'task'],
    ]);
  });

  it('counts every dollar once in the total spend', () => {
    expect(view(runs, costs, times).totals.usd).toBe(28);
  });

  it('counts the epic and the lone runs, not the subtasks, in the run totals', () => {
    expect(view(runs, costs, times).totals).toMatchObject({ runs: 4, done: 3, active: 1, failed: 0, merged: 2 });
  });

  it('counts epics and tasks on the day they started', () => {
    const day = view(runs, costs, times).days.find((entry) => entry.day === '2026-11-10');

    expect([day?.epics, day?.tasks]).toEqual([
      { done: 1, active: 0, failed: 0 },
      { done: 4, active: 1, failed: 1 },
    ]);
  });

  describe('a subtask its epic skipped (f123)', () => {
    const skipped = { status: 'blocked', state: 'skipped' };
    const epicRuns = [
      run(10, merged),
      run(11, { parentRunId: 10, ...skipped }),
      run(20, { state: 'closed' }),
      run(21, { parentRunId: 20, ...skipped }),
    ];
    const epicCosts: [number, number][] = [
      [10, 1],
      [11, 2],
      [20, 1],
      [21, 4],
    ];

    it('is in no task count and no task median', () => {
      const { tasks } = view(epicRuns, epicCosts, [
        [11, 500],
        [21, 500],
      ]);

      expect(tasks).toEqual({
        finished: 0,
        active: 0,
        failed: 0,
        medianUsd: 0,
        medianMs: null,
        back: 0,
        medianReturns: null,
      });
    });

    it('keeps its spend in its epic and in the total', () => {
      const stats = view(epicRuns, epicCosts);

      expect(stats.subtasks).toEqual([]);
      expect(stats.epics).toMatchObject({ finished: 2, medianUsd: 4 });
      expect(stats.totals.usd).toBe(8);
    });
  });
});
