import type { RunSummary } from '../contract/api';
import { RunListChanges } from './run-list-changes';

function view(...rows: Array<{ key: string; parentKey?: string; title?: string }>) {
  return { runs: rows.map((row) => ({ title: '', ...row }) as RunSummary) };
}

describe('RunListChanges', () => {
  const base = view({ key: 'a' }, { key: 'b', parentKey: 'a' }, { key: 'c' });

  it('has no baseline until a view is kept', () => {
    const changes = new RunListChanges();
    expect(changes.hasBaseline()).toBe(false);
    changes.reset(base);
    expect(changes.hasBaseline()).toBe(true);
  });

  it('returns a keyed row with its parent, and not an unchanged row', () => {
    const changes = new RunListChanges();
    changes.reset(base);
    const { rows, removed } = changes.since(base, ['b']);
    expect(rows.map((row) => row.key)).toEqual(['a', 'b']);
    expect(removed).toEqual([]);
  });

  it('returns a row that differs or is new, and the key that left the list, then keeps the view', () => {
    const changes = new RunListChanges();
    changes.reset(base);
    const next = view({ key: 'a', title: 'new title' }, { key: 'd' });
    const first = changes.since(next, []);
    expect(first.rows.map((row) => row.key)).toEqual(['a', 'd']);
    expect(first.removed).toEqual(['b', 'c']);
    expect(changes.since(next, [])).toEqual({ rows: [], removed: [] });
  });
});
