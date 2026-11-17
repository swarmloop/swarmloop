import { PlannerTurns, type PlannerTurn } from './planner-turns';

const turn = (id: string, at: string): PlannerTurn => ({ id, at, text: `text of ${id}` });

describe('PlannerTurns', () => {
  it('starts one turn at a time per run and the next one only after the first ends', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-1', turn('b', '2026-01-01T00:00:01.000Z'));
    expect(turns.begin('run-1')?.id).toBe('a');
    expect(turns.replying('run-1')).toBe(true);
    expect(turns.begin('run-1')).toBeNull();
    turns.end('run-1');
    expect(turns.replying('run-1')).toBe(false);
    expect(turns.begin('run-1')?.id).toBe('b');
  });

  it('orders the turns of a run by the time of their entries, not by when they were offered', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('late', '2026-01-01T00:00:05.000Z'));
    turns.offer('run-1', turn('early', '2026-01-01T00:00:01.000Z'));
    turns.offer('run-1', turn('same-as-late', '2026-01-01T00:00:05.000Z'));
    expect(turns.pending('run-1').map((held) => held.id)).toEqual(['early', 'late', 'same-as-late']);
  });

  it('holds a turn that is offered again once, also while it runs', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    expect(turns.pending('run-1')).toHaveLength(1);
    turns.begin('run-1');
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    expect(turns.pending('run-1')).toEqual([]);
  });

  it('keeps the runs apart', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-2', turn('b', '2026-01-01T00:00:00.000Z'));
    expect(turns.begin('run-1')?.id).toBe('a');
    expect(turns.begin('run-2')?.id).toBe('b');
    expect(turns.begin('run-3')).toBeNull();
  });
});
