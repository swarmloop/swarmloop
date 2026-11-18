import { describe, expect, it } from 'vitest';
import { composerHint } from './composer-hint';

describe('composerHint', () => {
  it('says what sending does for planning, implement, a split run, a done run with an open merge request and a merged run', () => {
    expect([
      composerHint('plan'),
      composerHint('amend'),
      composerHint('add-tasks'),
      composerHint('reopen'),
      composerHint('follow-up'),
    ]).toEqual([
      'goes into the plan',
      'amends the plan when the current step ends',
      'adds tasks to the epic',
      'reopens this run and updates its merge request',
      'starts a follow-up run',
    ]);
  });

  it('has no hint where there is no message box', () => {
    expect(composerHint('read-only')).toBeUndefined();
  });
});
