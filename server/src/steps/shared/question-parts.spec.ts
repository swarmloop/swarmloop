import type { ReviewResult } from '../../agent-result/definitions/review';
import { askedQuestion, questionFor } from '../implement/split-questions';
import {
  answeredBefore,
  askedParts,
  readAnsweredQuestions,
  readStoredQuestions,
  reviewParts,
  type AnsweredQuestion,
  type PlannerLine,
} from './question-parts';

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

  it('says who asked: the task of a handed-up question and the reviewer of a review question', () => {
    const handedUp = askedQuestion('a', 'Which one?', ASKED_AT).parts;
    expect(handedUp.asker).toBe('subtask:a');
    expect(handedUp.entry).toBeUndefined();
    expect(reviewParts('quality', { finding: 'f', answer: null }, result({}), ASKED_AT).asker).toBe(
      'code-review-quality',
    );
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

  it('gives a question that went up the chain one side per planner, in order', () => {
    const lines: PlannerLine[] = [
      { who: 'run planner', text: 'Not sure.' },
      { who: 'epic planner', text: 'The planner gave no answer.' },
    ];

    expect(askedParts('Which one?', ASKED_AT, {}, lines).sides).toEqual(lines);
  });

  it('finds the answer already given to the same asker, whatever the whitespace and the time asked', () => {
    const record: AnsweredQuestion[] = [{ asker: 'a', decide: ' Which\n one? ', answer: 'This one', at: ASKED_AT }];

    expect(answeredBefore(record, 'a', 'Which   one?')).toBe('This one');
    expect(answeredBefore(record, 'b', 'Which one?')).toBeNull();
    expect(answeredBefore(record, 'a', 'Which other?')).toBeNull();
  });

  it('reads a stored list, and an empty one from a body that is not a list', () => {
    const stored = [{ question: 'a', parts: askedParts('a', ASKED_AT) }];

    expect(readStoredQuestions(JSON.stringify(stored))).toEqual(stored);
    expect(readStoredQuestions('not json')).toEqual([]);
    expect(readStoredQuestions('{"a":1}')).toEqual([]);
  });

  it('reads the record of answers, and none from an empty body', () => {
    const record: AnsweredQuestion[] = [{ asker: 'subtask:a', decide: 'Which?', answer: 'This', at: ASKED_AT }];

    expect(readAnsweredQuestions(JSON.stringify(record))).toEqual(record);
    expect(readAnsweredQuestions('')).toEqual([]);
  });
});
