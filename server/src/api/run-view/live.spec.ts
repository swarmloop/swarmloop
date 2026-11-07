import { liveVisitKey, visitKey } from '../../contract/visit-key';
import { liveVisit } from './live';

describe('visit keys', () => {
  it('gives a live visit a key of its step and attempt, distinct from stored visit keys', () => {
    const root = '/nonexistent-run-root';
    const live = liveVisit(
      'run-1',
      'implement',
      root,
      13,
      '2026-11-07T10:00:00.000Z',
      Date.parse('2026-11-07T10:01:00.000Z'),
    );
    const other = liveVisit(
      'run-1',
      'commit',
      root,
      13,
      '2026-11-07T10:00:00.000Z',
      Date.parse('2026-11-07T10:01:00.000Z'),
    );
    const stored = [1, 2, 13].map((id) => ({ id, key: visitKey(id) }));

    const keys = [...stored.map((item) => item.key), live.key, other.key];

    expect(live.id).toBe(-1);
    expect(live.key).toBe('live-implement-14');
    expect(other.key).toBe(liveVisitKey('commit', 14));
    expect(stored.map((item) => item.key)).toEqual(['visit-1', 'visit-2', 'visit-13']);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
