import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { liveVisitKey, visitKey } from '../../contract/visit-key';
import { liveVisit } from './live';

describe('visit keys', () => {
  it('gives a live visit a key of its step and attempt, distinct from stored visit keys', () => {
    const root = '/nonexistent-run-root';
    const live = liveVisit(
      'run-1',
      'implement',
      root,
      null,
      13,
      '2026-11-07T10:00:00.000Z',
      Date.parse('2026-11-07T10:01:00.000Z'),
    );
    const other = liveVisit(
      'run-1',
      'commit',
      root,
      null,
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

describe('running visit log', () => {
  it('shows only the active attempt, not an earlier one whose id sorts later', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-live-visit-'));
    mkdirSync(join(root, 'data'));
    const first = join(root, 'data', 'K-1-implement-zzz-output.txt');
    const second = join(root, 'data', 'K-1-implement-aaa-output.txt');
    writeFileSync(first, 'attempt one\n');
    writeFileSync(second, 'attempt two\n');
    utimesSync(first, new Date(1000), new Date(1000));
    utimesSync(second, new Date(2000), new Date(2000));
    const live = liveVisit('K-1', 'implement', root, 'aaa', 1, '2026-11-07T10:00:00.000Z', Date.now());
    expect(live.documents[0]?.body).toBe('attempt two\n');
  });
});
