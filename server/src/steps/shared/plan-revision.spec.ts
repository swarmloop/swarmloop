import { buildRevision } from './plan-revision';

const at = '2026-11-17T10:00:00.000Z';

describe('buildRevision', () => {
  it('is version 2 for the first change and names the reason', () => {
    const revision = buildRevision({ before: ['a'], after: ['a', 'b'], reason: 'add b', known: [], at });
    expect(revision).toEqual({
      version: 2,
      reason: 'add b',
      summary: 'Added 1 item',
      added: ['b'],
      changed: [],
      dropped: [],
      at,
    });
  });

  it('is one more than the highest stored version', () => {
    const known = [
      { version: 3, reason: 'x', summary: 's', added: [], changed: [], dropped: [], at },
      { version: 2, reason: 'y', summary: 's', added: [], changed: [], dropped: [], at },
    ];
    expect(buildRevision({ before: ['a'], after: ['b'], reason: 'r', known, at }).version).toBe(4);
  });

  it('finds added, changed and dropped items by comparing the lists', () => {
    const revision = buildRevision({
      before: ['keep', 'old one', 'old two', 'old three'],
      after: ['keep', 'new one', 'extra'],
      reason: 'r',
      known: [],
      at,
    });
    expect(revision.changed).toEqual(['new one', 'extra']);
    expect(revision.dropped).toEqual(['old three']);
    expect(revision.added).toEqual([]);
    expect(revision.summary).toBe('Changed 2 items, dropped 1 item');
  });

  it('says so when only the order moved', () => {
    expect(buildRevision({ before: ['a', 'b'], after: ['b', 'a'], reason: 'r', known: [], at }).summary).toBe(
      'Reordered the items',
    );
  });
});
