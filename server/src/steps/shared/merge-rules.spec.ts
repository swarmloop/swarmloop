import { CLOSED_NOTE, decideMerge, type MergeFacts } from './merge-rules';

type MainTarget = Extract<MergeFacts['target'], { kind: 'main' }>;

function facts(overrides: Partial<MergeFacts> = {}, gate: Partial<MergeFacts['gate']> = {}): MergeFacts {
  return {
    repository: 'web',
    behind: false,
    rebaseSent: false,
    branch: 'swarmloop/t1',
    target: main(),
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

function main(overrides: Partial<MainTarget> = {}): MergeFacts['target'] {
  return { kind: 'main', mode: 'green', manual: false, mergeOk: false, mainWait: null, ...overrides };
}

describe('decideMerge', () => {
  it('merges a clean request on a green main with the head as guard', () => {
    expect(decideMerge(facts())).toEqual({ kind: 'merge', head: 'h1' });
  });

  it('waits for the OK in mode ok', () => {
    expect(decideMerge(facts({ target: main({ mode: 'ok' }) })).kind).toBe('wait');
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

  it('rebases a request that is behind or conflicting once, then needs a person', () => {
    expect(decideMerge(facts({}, { mergeability: 'behind' }))).toEqual({ kind: 'rebase' });
    expect(decideMerge(facts({}, { mergeability: 'conflicting' }))).toEqual({ kind: 'rebase' });
    expect(decideMerge(facts({ rebaseSent: true }, { mergeability: 'behind' }))).toEqual({
      kind: 'person',
      note: 'still behind swarmloop/t1 after a rebase; needs a person',
    });
  });

  it('rebases a request the target reads as behind, once, though the host calls it clean', () => {
    expect(decideMerge(facts({ behind: true }))).toEqual({ kind: 'rebase' });
    expect(decideMerge(facts({ behind: true, rebaseSent: true }))).toEqual({
      kind: 'person',
      note: 'still behind swarmloop/t1 after a rebase; needs a person',
    });
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

  it('waits for the words of a main that does not pass', () => {
    expect(decideMerge(facts({ target: main({ mainWait: 'waits for a green main of web' }) }))).toEqual({
      kind: 'wait',
      note: 'waits for a green main of web',
    });
  });

  it('waits for the owner in mode ok and for a manual task, until the OK is given', () => {
    const wait = { kind: 'wait', note: 'waits for your OK to merge' };
    expect(decideMerge(facts({ target: main({ mode: 'ok' }) }))).toEqual(wait);
    expect(decideMerge(facts({ target: main({ manual: true }) }))).toEqual(wait);
    expect(decideMerge(facts({ target: main({ mode: 'ok', mergeOk: true }) }))).toEqual({ kind: 'merge', head: 'h1' });
    expect(decideMerge(facts({ target: main({ manual: true, mergeOk: true }) }))).toEqual({
      kind: 'merge',
      head: 'h1',
    });
  });

  it('puts the wait for a main before the owner OK', () => {
    const target = main({ mode: 'ok', mainWait: 'waits for a green main of web' });
    expect(decideMerge(facts({ target }))).toEqual({ kind: 'wait', note: 'waits for a green main of web' });
  });

  it('never makes a feature branch wait for a main or an OK', () => {
    expect(decideMerge(facts({ target: { kind: 'branch' } }))).toEqual({ kind: 'merge', head: 'h1' });
  });
});
