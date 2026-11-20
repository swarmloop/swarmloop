import { at, finishedRun, MIN } from './eta.spec-helpers';
import { stepNumbers } from './step-numbers';

describe('stepNumbers', () => {
  it('gives an empty table for no history', () => {
    const table = stepNumbers([]);
    expect(table.plain).toEqual({ steps: {}, whole: null });
    expect(table.subtask).toEqual({ steps: {}, whole: null });
  });

  it('uses only the newest 50 runs that entered the step', () => {
    const old = Array.from({ length: 30 }, (_, i) =>
      finishedRun(i, { entries: [{ step: 'implement', startedAt: at(i - 100) }] }),
    );
    const fresh = Array.from({ length: 50 }, (_, i) => finishedRun(1000 + i));
    const table = stepNumbers([...old, ...fresh]);
    expect(table.plain.steps.implement).toBe(30 * MIN);
    expect(table.plain.whole).toBe(60 * MIN);
  });

  it('takes the median of the samples', () => {
    const runs = [10, 20, 90].map((spent, i) =>
      finishedRun(i, { entries: [{ step: 'checks', startedAt: at(i - spent) }] }),
    );
    expect(stepNumbers(runs).plain.steps.checks).toBe(20 * MIN);
  });

  it('leaves person and limit stretches out of the time', () => {
    const waits = [
      { from: at(-25), to: at(-20) },
      { from: at(-5), to: null },
    ];
    const table = stepNumbers([finishedRun(0, { waits })]);
    expect(table.plain.steps.implement).toBe(20 * MIN);
    expect(table.plain.whole).toBe(50 * MIN);
  });

  it('samples a step entered twice from its first entry', () => {
    const entries = [
      { step: 'implement', startedAt: at(-10) },
      { step: 'implement', startedAt: at(-40) },
    ];
    expect(stepNumbers([finishedRun(0, { entries })]).plain.steps.implement).toBe(40 * MIN);
  });

  it('keeps subtask numbers apart and ends them at the merge', () => {
    const task = finishedRun(0, { parentRunId: 'p', lastFinishedAt: at(50), mergedAt: at(-5) });
    const table = stepNumbers([task, finishedRun(0)]);
    expect(table.subtask.steps.implement).toBe(25 * MIN);
    expect(table.plain.steps.implement).toBe(30 * MIN);
    expect(table.epic.steps).toEqual({});
  });

  it('skips runs without an end', () => {
    expect(stepNumbers([finishedRun(0, { lastFinishedAt: null })]).plain.steps).toEqual({});
  });
});
