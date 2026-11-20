import type { StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import { handBackErrors, handBackLine } from './hand-back';

const added = {
  id: 'docs',
  title: 'Docs',
  description: 'Write them.',
  depends: [],
  files: ['docs.md'],
  proof: 'a doc',
};

describe('a part a task hands back', () => {
  it('says in its line when the task cannot go on without the part', () => {
    expect(handBackLine({ what: ' the cache ', needed: false })).toBe('hands back: the cache');
    expect(handBackLine({ what: 'the cache', needed: true })).toBe(
      'hands back (the task cannot go on without it): the cache',
    );
  });

  it('refuses a decision that neither assigns the part nor adds a task for it', () => {
    const answer: StarterAnswerResult = { decision: 'Skip it.' };
    expect(handBackErrors('- hands back: the cache\n', answer)).toEqual([
      'a part handed back is never dropped: assign it with changeTask to a task that has not started, or addTask',
    ]);
  });

  it('wants waitFor when the asking task needs the part', () => {
    const asked = `- ${handBackLine({ what: 'the cache', needed: true })}\n`;
    expect(handBackErrors(asked, { decision: 'Added.', addTask: [added] })).toEqual([
      'the asking task needs the part: give waitFor on the task that gets it',
    ]);
    expect(
      handBackErrors(asked, { decision: 'Added.', addTask: [added], waitFor: [{ id: 'docs', what: 'docs' }] }),
    ).toEqual([]);
  });

  it('leaves the answer to an ordinary question alone', () => {
    expect(handBackErrors('- Which column?\n', { decision: 'The first.' })).toEqual([]);
  });
});
