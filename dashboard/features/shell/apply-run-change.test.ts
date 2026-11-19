import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@contract/api';
import type { RunChange } from '@contract/run-list';
import { runSummary } from '../../test/fixtures';
import { applyRunChange } from './apply-run-change';

const COUNTS = { active: 0, done: 0, all: 0 };
const run = (key: string, day: number, overrides: Partial<RunSummary> = {}): RunSummary => ({
  ...runSummary(),
  key,
  name: key,
  title: key,
  createdAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`,
  ...overrides,
});
const change = (rows: RunSummary[], removed: string[] = []): RunChange => ({ rows, removed, counts: COUNTS });
const keys = (runs: RunSummary[]): string[] => runs.map((item) => item.key);
const active = { part: 'active' as const, q: '', next: null };
const done = { part: 'done' as const, q: '', next: null };
const finished = { state: 'merged' as const, status: 'done' as const };

describe('applyRunChange', () => {
  it('replaces a held row', () => {
    const held = [run('a', 3), run('b', 2)];

    const result = applyRunChange({ runs: held, ...active }, change([run('b', 2, { title: 'new title' })]));

    expect(result.map((item) => item.title)).toEqual(['a', 'new title']);
  });

  it('adds a run that became active', () => {
    const held = [run('a', 3), run('c', 1)];

    const result = applyRunChange({ runs: held, ...active }, change([run('b', 2)]));

    expect(keys(result)).toEqual(['a', 'b', 'c']);
  });

  it('moves a run that became done out of Active and into a loaded Done page at its place', () => {
    const inActive = applyRunChange({ runs: [run('a', 3), run('b', 2)], ...active }, change([run('b', 2, finished)]));
    const inDone = applyRunChange(
      { runs: [run('x', 4, finished), run('y', 1, finished)], ...done, next: 'c1' },
      change([run('b', 2, finished)]),
    );

    expect(keys(inActive)).toEqual(['a']);
    expect(keys(inDone)).toEqual(['x', 'b', 'y']);
  });

  it('ignores a group older than the loaded range', () => {
    const held = [run('x', 4, finished), run('y', 3, finished)];
    const old = run('old', 1, finished);

    const paged = applyRunChange({ runs: held, ...done, next: 'c1' }, change([old]));
    const whole = applyRunChange({ runs: held, ...done }, change([old]));

    expect(keys(paged)).toEqual(['x', 'y']);
    expect(keys(whole)).toEqual(['x', 'y', 'old']);
  });

  it('keeps a held subtask with its top when the top changes', () => {
    const held = [run('p', 3), run('p-1', 3, { parentKey: 'p' })];

    const result = applyRunChange({ runs: held, ...active }, change([run('p', 3, { title: 'epic' })]));

    expect(result.map((item) => item.title)).toEqual(['epic', 'p-1']);
  });

  it('drops removed keys', () => {
    const result = applyRunChange({ runs: [run('a', 3), run('b', 2)], ...active }, change([], ['a']));

    expect(keys(result)).toEqual(['b']);
  });
});
