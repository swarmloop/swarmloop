import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@contract/api';
import { runSummary } from '../../test/fixtures';
import { filterRuns, parsePart, showQuery } from './run-filter';

const run = (key: string, overrides: Partial<RunSummary> = {}): RunSummary => ({
  ...runSummary(),
  key,
  name: `Name of ${key}`,
  ...overrides,
});

const keys = (runs: RunSummary[]): string[] => runs.map((item) => item.key);

describe('filterRuns', () => {
  it('counts 1 working, 2 failed and 134 merged runs and shows only the active 3', () => {
    const runs = [
      run('w', { state: 'running' }),
      run('f1', { state: 'failed' }),
      run('f2', { state: 'failed' }),
      ...Array.from({ length: 134 }, (_, n) => run(`m${n}`, { state: 'merged' })),
    ];

    const { visible, counts } = filterRuns(runs, '', 'active');

    expect(counts).toEqual({ active: 3, done: 134, all: 137 });
    expect(keys(visible)).toEqual(['w', 'f1', 'f2']);
  });

  it('counts an epic with a running task once, in Active, and keeps its tasks', () => {
    const runs = [run('e', { state: 'waiting' }), run('e-A', { parentKey: 'e', state: 'running' })];

    const { visible, counts } = filterRuns(runs, '', 'active');

    expect(counts).toEqual({ active: 1, done: 0, all: 1 });
    expect(keys(visible)).toEqual(['e', 'e-A']);
  });

  it('classes an epic by its parent: a merged parent with a running task is Done', () => {
    const runs = [run('e', { state: 'merged' }), run('e-A', { parentKey: 'e', state: 'running' })];

    expect(filterRuns(runs, '', 'active').counts).toEqual({ active: 0, done: 1, all: 1 });
    expect(keys(filterRuns(runs, '', 'done').visible)).toEqual(['e', 'e-A']);
  });

  it('matches a word of the name, the key, and the name of an epic task', () => {
    const runs = [
      run('a', { name: 'Fix the login page', state: 'running' }),
      run('b', { name: 'Other', state: 'running' }),
      run('e', { state: 'running' }),
      run('e-A', { name: 'Rename widget', parentKey: 'e', state: 'running' }),
    ];

    expect(keys(filterRuns(runs, 'login', 'active').visible)).toEqual(['a']);
    expect(keys(filterRuns(runs, 'b', 'active').visible)).toEqual(['b']);
    expect(keys(filterRuns(runs, 'widget', 'active').visible)).toEqual(['e', 'e-A']);
  });

  it('trims the query and ignores case', () => {
    const runs = [run('a', { name: 'Fix the Login page', state: 'running' })];

    expect(keys(filterRuns(runs, '  LOGIN ', 'active').visible)).toEqual(['a']);
  });

  it('counts the matches in the other part, and none for All', () => {
    const runs = [
      run('a1', { name: 'shared', state: 'running' }),
      run('d1', { name: 'shared', state: 'merged' }),
      run('d2', { name: 'shared', state: 'closed' }),
      run('d3', { name: 'unrelated', state: 'merged' }),
    ];

    expect(filterRuns(runs, 'shared', 'active').otherMatches).toBe(2);
    expect(filterRuns(runs, 'shared', 'done').otherMatches).toBe(1);
    expect(filterRuns(runs, 'shared', 'all').otherMatches).toBe(0);
    expect(filterRuns(runs, 'shared', 'all').visible).toHaveLength(3);
  });

  it('counts a subtask without its parent as a top-level run', () => {
    const runs = [run('x-A', { parentKey: 'x', state: 'running' })];

    expect(filterRuns(runs, '', 'active').counts).toEqual({ active: 1, done: 0, all: 1 });
  });
});

describe('parsePart', () => {
  it('reads the three parts and falls back to active', () => {
    expect(parsePart('done')).toBe('done');
    expect(parsePart('all')).toBe('all');
    expect(parsePart('bogus')).toBe('active');
    expect(parsePart(null)).toBe('active');
  });
});

describe('showQuery', () => {
  it('keeps the part of the address as a query, and nothing when the address has none', () => {
    expect(showQuery(new URLSearchParams('show=done'))).toBe('?show=done');
    expect(showQuery(new URLSearchParams(''))).toBe('');
  });

  it('falls back to Active for an unknown part and drops every other parameter', () => {
    expect(showQuery(new URLSearchParams('show=nope&q=secret'))).toBe('?show=active');
    expect(showQuery(new URLSearchParams('q=secret'))).toBe('');
  });
});
