import type { ReviewResult } from '../../agent-result/definitions/review';
import type { Exchange } from './review-exchange';
import type { Finished } from './reviewer';
import type { DocumentRepository } from '../../history/document.repository';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import { renderQuestions } from '../research/research-record';
import { reviewAnswerKey } from '../shared/review-answer-key';
import { renderReview } from './code-review-record';
import { reviewAsks, settleAsked } from './review-ask';

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

describe('settling the questions of a subtask review by the epic planner', () => {
  const question = 'code still returns: x. Implement answered: nothing. Which holds? (asked t)';
  const answers = `question: ${question}\nanswer: stands\n`;
  const returned: ReviewResult = {
    decision: 'return',
    review: 'The parser drops a row.',
    summary: ['one'],
    sections: { quality: 'The parser drops a row.', security: 'checked' },
  };
  const passed: ReviewResult = {
    decision: 'ok',
    review: 'Fine.',
    summary: ['ok'],
    reason: 'fine',
    sections: { quality: 'checked', security: 'checked' },
  };

  function setup(entries: object[], reviews: Record<string, ReviewResult>) {
    const taken: string[] = [];
    const ended: unknown[] = [];
    const bodies: Record<string, string> = {};
    for (const [name, review] of Object.entries(reviews)) {
      bodies[`review_${name}`] = renderReview(review);
      bodies[`review_${name}_result`] = JSON.stringify(review);
    }
    const stored = [
      { id: 5, kind: ARTIFACTS.reviewQuestions.kind, body: renderQuestions([question]) },
      { id: 6, kind: ARTIFACTS.answers.kind, body: answers },
    ];
    const documents = {
      listDocuments: async () => stored,
      latestBody: async (_key: string, kind: string) => bodies[kind] ?? null,
    } as unknown as DocumentRepository;
    const planner = {
      chat: {
        read: async () => ({ entries, revisions: [] }),
        markTaken: async (_key: string, keys: string[]) => void taken.push(...keys),
      },
      events: { append: async () => undefined, recordLoop: async () => undefined },
    } as never;
    const ctx = {
      opened: { run: { id: 1, key: 'child', attemptsReview: 0 }, startedAt: 't', started: 0 },
      clock: { iso: () => 't', now: () => 0 },
      reread: async () => '{"prompt":"Ship it."}',
      end: async (result: unknown) => void ended.push(result),
    } as unknown as StepContext;
    return { documents, planner, ctx, taken, ended };
  }
  const entry = (finding: 'holds' | 'ruled-out') => ({
    key: reviewAnswerKey(5),
    role: 'planner',
    kind: 'answer',
    from: 'code-review',
    finding,
    text: 'It does not hold.',
    at: 't',
    state: 'pending',
  });

  it('closes the round as an ok round when the planner ruled the finding out', async () => {
    const { documents, planner, ctx, taken, ended } = setup([entry('ruled-out')], { code: returned });
    await settleAsked(ctx, documents, planner);
    expect(ended).toMatchObject([
      {
        moveTo: undefined,
        visit: {
          documents: expect.arrayContaining([
            expect.objectContaining({ body: expect.stringContaining('decision: ok') }),
          ]),
        },
      },
    ]);
    expect(taken).toEqual([reviewAnswerKey(5)]);
  });

  it('rules out only the asked return and sends the return of a reviewer that asked nothing to implement', async () => {
    const other: ReviewResult = {
      decision: 'return',
      review: 'The cache leaks.',
      summary: ['two'],
      sections: { regressions: 'checked', performance: 'The cache leaks.' },
    };
    const { documents, planner, ctx, taken, ended } = setup([entry('ruled-out')], {
      code: returned,
      behavior: other,
    });
    await settleAsked(ctx, documents, planner);
    expect(ended).toMatchObject([{ moveTo: 'implement' }]);
    expect(taken).toEqual([reviewAnswerKey(5)]);
  });

  it('sends the return to implement and takes the answer when the planner says it holds', async () => {
    const { documents, planner, ctx, taken, ended } = setup([entry('holds')], { code: returned });
    await settleAsked(ctx, documents, planner);
    expect(ended).toMatchObject([{ moveTo: 'implement' }]);
    expect(taken).toEqual([reviewAnswerKey(5)]);
  });

  it('sends the return to implement as before when the answer has no typed finding', async () => {
    const { documents, planner, ctx, taken, ended } = setup([], { code: returned, behavior: passed });
    await settleAsked(ctx, documents, planner);
    expect(ended).toMatchObject([{ moveTo: 'implement' }]);
    expect(taken).toEqual([]);
  });

  it('does not read a taken answer of an earlier ask of the same question', async () => {
    const earlier = { ...entry('ruled-out'), key: reviewAnswerKey(2), state: 'taken' };
    const { documents, planner, ctx, ended } = setup([earlier], { code: returned });
    await settleAsked(ctx, documents, planner);
    expect(ended).toMatchObject([{ moveTo: 'implement' }]);
  });
});
