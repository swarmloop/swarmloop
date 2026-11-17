import type { ReviewResult } from '../../agent-result/definitions/review';
import { askedQuestion, questionFor } from '../implement/split-questions';
import { askedParts, keepOpen, readStoredQuestions, reviewParts, type StoredQuestion } from './question-parts';

const ASKED_AT = '2026-11-15T07:11:43.444Z';

function result(extra: Partial<ReviewResult>): ReviewResult {
  return { decision: 'return', review: 'text', summary: [], ...extra };
}

describe('question parts', () => {
  it('names only the marks that are not met, and the missing answer of implement', () => {
    const requirements = [
      { id: 'Do 3', status: 'met' as const, note: 'fine' },
      { id: 'Do 4', status: 'missing' as const, note: 'the skill does not point to project-base.md' },
      { id: 'Do 5', status: 'partial' as const, note: 'half done' },
    ];
    const parts = reviewParts(
      'requirements',
      { finding: '1. Do 3 met\n2. Do 4 missing', answer: null },
      result({ requirements }),
      ASKED_AT,
    );

    expect(parts.decide).toBe('Is the requirements review right that Do 4 is missing, Do 5 is partial?');
    expect(parts.sides).toEqual([
      {
        who: 'requirements',
        text: 'Do 4 is missing: the skill does not point to project-base.md\nDo 5 is partial: half done',
      },
      { who: 'implement', text: 'Implement did not answer this point' },
    ]);
    expect(parts.full).toBe('1. Do 3 met\n2. Do 4 missing');
    expect(parts.askedAt).toBe(ASKED_AT);
  });

  it('falls back to the reason of the reviewer and shows the answer of implement', () => {
    const parts = reviewParts(
      'quality',
      { finding: 'f', answer: ' It is on purpose. ' },
      result({ reason: 'still wrong' }),
      ASKED_AT,
    );

    expect(parts.decide).toBe('Is the quality review right that still wrong?');
    expect(parts.sides).toEqual([
      { who: 'quality', text: 'still wrong' },
      { who: 'implement', text: 'It is on purpose.' },
    ]);
  });

  it('gives a subtask question the planner side and no full text', () => {
    const parts = askedParts('Which one?', ASKED_AT);

    expect(parts).toEqual({
      decide: 'Which one?',
      sides: [{ who: 'planner', text: 'The planner gave no answer.' }],
      full: '',
      askedAt: ASKED_AT,
    });
    expect(askedQuestion('a', 'Which one?', ASKED_AT).question).toBe(questionFor('a', 'Which one?', ASKED_AT));
  });

  it('keeps the parts of the questions still open and adds the new ones', () => {
    const entry = (question: string): StoredQuestion => ({ question, parts: askedParts(question, ASKED_AT) });

    expect(keepOpen([entry('a'), entry('b')], ['b'], [entry('c')]).map((item) => item.question)).toEqual(['b', 'c']);
  });

  it('reads a stored list, and an empty one from a body that is not a list', () => {
    const stored = [{ question: 'a', parts: askedParts('a', ASKED_AT) }];

    expect(readStoredQuestions(JSON.stringify(stored))).toEqual(stored);
    expect(readStoredQuestions('not json')).toEqual([]);
    expect(readStoredQuestions('{"a":1}')).toEqual([]);
  });
});
