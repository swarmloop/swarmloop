import { CLOSED_NOTE, decideMerge, type MergeFacts } from './merge-rules';

function facts(overrides: Partial<MergeFacts> = {}, gate: Partial<MergeFacts['gate']> = {}): MergeFacts {
  return {
    mode: 'green',
    manual: false,
    mergeOk: false,
    repository: 'web',
    main: { state: 'green' },
    fixesMainHere: false,
    gate: {
      state: 'open',
      sha: null,
      draft: false,
      head: 'h1',
      mergeability: 'clean',
      blockedBy: null,
      failing: [],
      pending: [],
      ...gate,
    },
    ...overrides,
  };
}

describe('decideMerge', () => {
  it('merges a clean request on a green main with the head as guard', () => {
    expect(decideMerge(facts())).toEqual({ kind: 'merge', head: 'h1' });
  });

  it('merges on a main with no CI in mode green, and waits for the OK in mode ok', () => {
    expect(decideMerge(facts({ main: { state: 'none' } }))).toEqual({ kind: 'merge', head: 'h1' });
    expect(decideMerge(facts({ main: { state: 'none' }, mode: 'ok' })).kind).toBe('wait');
  });

  it('names a request closed without a merge', () => {
    expect(decideMerge(facts({}, { state: 'closed' }))).toEqual({ kind: 'person', note: CLOSED_NOTE });
  });

  it('records the commit of a request merged on the host, the head when the host gives none', () => {
    expect(decideMerge(facts({}, { state: 'merged', sha: 's9' }))).toEqual({ kind: 'merged', sha: 's9' });
    expect(decideMerge(facts({}, { state: 'merged' }))).toEqual({ kind: 'merged', sha: 'h1' });
  });

  it('waits for a draft and for unknown mergeability', () => {
    expect(decideMerge(facts({}, { draft: true }))).toEqual({
      kind: 'wait',
      note: 'waits for its merge request to leave draft',
    });
    expect(decideMerge(facts({}, { mergeability: 'unknown' }))).toEqual({
      kind: 'wait',
      note: 'waits for the host to tell whether it merges',
    });
  });

  it('rebases a request that is behind or conflicting, never needs a person', () => {
    expect(decideMerge(facts({}, { mergeability: 'behind' }))).toEqual({ kind: 'rebase' });
    expect(decideMerge(facts({}, { mergeability: 'conflicting' }))).toEqual({ kind: 'rebase' });
  });

  it('names failing checks before pending checks before reviews', () => {
    const blocked = { mergeability: 'blocked', blockedBy: 'review required' } as const;
    expect(decideMerge(facts({}, { ...blocked, failing: ['lint'], pending: ['e2e'] }))).toEqual({
      kind: 'person',
      note: 'checks failing: lint; needs a person',
    });
    expect(decideMerge(facts({}, { ...blocked, pending: ['e2e', 'build'] }))).toEqual({
      kind: 'person',
      note: 'checks pending: e2e, build; needs a person',
    });
    expect(decideMerge(facts({}, blocked))).toEqual({
      kind: 'person',
      note: 'reviews: review required; needs a person',
    });
    expect(decideMerge(facts({}, { mergeability: 'blocked' }))).toEqual({
      kind: 'person',
      note: 'reviews: blocked; needs a person',
    });
  });

  it('waits for a green main, and says why one cannot be read', () => {
    expect(decideMerge(facts({ main: { state: 'red' } }))).toEqual({
      kind: 'wait',
      note: 'waits for a green main of web',
    });
    expect(decideMerge(facts({ main: undefined }))).toEqual({ kind: 'wait', note: 'waits for a green main of web' });
    expect(decideMerge(facts({ main: { state: 'unreadable', note: 'host down' } }))).toEqual({
      kind: 'wait',
      note: 'waits for a green main of web: host down',
    });
  });

  it('merges the task that fixes this main on its red main', () => {
    expect(decideMerge(facts({ main: { state: 'red' }, fixesMainHere: true }))).toEqual({ kind: 'merge', head: 'h1' });
  });

  it('waits for the owner in mode ok and for a manual task, until the OK is given', () => {
    const wait = { kind: 'wait', note: 'waits for your OK to merge' };
    expect(decideMerge(facts({ mode: 'ok' }))).toEqual(wait);
    expect(decideMerge(facts({ manual: true }))).toEqual(wait);
    expect(decideMerge(facts({ mode: 'ok', mergeOk: true }))).toEqual({ kind: 'merge', head: 'h1' });
    expect(decideMerge(facts({ manual: true, mergeOk: true }))).toEqual({ kind: 'merge', head: 'h1' });
  });

  it('puts a red main before the owner OK', () => {
    expect(decideMerge(facts({ mode: 'ok', main: { state: 'pending' } }))).toEqual({
      kind: 'wait',
      note: 'waits for a green main of web',
    });
  });
});
