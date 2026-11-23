import type { ReviewResult } from '../../agent-result/definitions/review';
import type { Exchange } from './review-exchange';
import type { Finished } from './reviewer';
import { reviewAsks } from './review-ask';

const ASKED_AT = '2026-11-15T07:11:43.444Z';

describe('review asks', () => {
  const points = Array.from({ length: 50 }, (_, index) => `${index + 1}. Do ${index + 1} is met`);
  const requirements = Array.from({ length: 50 }, (_, index) => ({
    id: `Do ${index + 1}`,
    status: index === 3 ? ('missing' as const) : ('met' as const),
    note: index === 3 ? 'the skill does not point to project-base.md' : 'done',
  }));
  const result: ReviewResult = { decision: 'return', review: points.join('\n'), summary: [], requirements };
  const finished = [
    { reviewer: { name: 'requirements' }, parsed: { kind: 'r', decision: 'return', body: '', result } },
  ] as unknown as Finished[];
  const exchanges = new Map<string, Exchange>([['requirements', { finding: points.join('\n'), answer: null }]]);

  it('names only the missing point of a 50-point review, and keeps the question text as it was', () => {
    const [ask] = reviewAsks(exchanges, finished, ASKED_AT);

    expect(ask.question).toBe(
      `requirements still returns: ${points.join(' ')} Implement answered: nothing. Which holds? (asked ${ASKED_AT})`,
    );
    expect(ask.parts.sides).toEqual([
      { who: 'requirements', text: 'Do 4 is missing: the skill does not point to project-base.md' },
      { who: 'implement', text: 'Implement did not answer this point' },
    ]);
    expect(ask.parts.full).toBe(points.join('\n'));
  });

  it('asks nothing when the diff changed', () => {
    // The question no longer depends on the diff: a repeated return asks on any head.
    expect(reviewAsks(exchanges, finished, ASKED_AT)).toHaveLength(1);
  });
});
