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

  it("says a subtask's message goes to its planner, and an ended one's to the epic's", () => {
    expect([composerHint('subtask'), composerHint('epic')]).toEqual([
      "goes to this task's planner",
      "goes to the epic's planner",
    ]);
  });
});
