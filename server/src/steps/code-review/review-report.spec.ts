import type { StepContext } from '../base-step';
import type { OpenedStep } from '../step-run';
import type { ReviewDeps, Finished } from './reviewer';
import { opinionOf, reviewDocuments } from './code-review-record';
import { closeReview, recordAngle, reviewBrief } from './review-report';

describe('review brief', () => {
  it('gives the report the decision and the full text of each check', () => {
    const text = reviewBrief([
      {
        kind: 'review_code',
        decision: 'return',
        body: 'summary:\n- The parser drops an empty segment\n\ndecision: return\n',
      },
      { kind: 'review_behavior', decision: 'ok', body: 'summary:\n- The query stays parameterized\n\ndecision: ok\n' },
    ]);
    expect(text).toContain('## Code\ndecision: return\n\nsummary:');
    expect(text).toContain('The parser drops an empty segment');
    expect(text).toContain('## Behavior\ndecision: ok');
    expect(text.indexOf('## Code')).toBeLessThan(text.indexOf('## Behavior'));
  });
});

describe('review brief with an answer', () => {
  it('shows the answer of implement under the reviewer that saw it, and nothing under the others', () => {
    const text = reviewBrief(
      [
        { kind: 'review_code', decision: 'return', body: 'The parser drops a segment.\ndecision: return\n' },
        { kind: 'review_behavior', decision: 'ok', body: 'Safe.\ndecision: ok\n' },
      ],
      new Map([['code', { finding: 'The parser drops a segment.', answer: 'The plan removes it.' }]]),
    );
    expect(text).toContain('decision: return\n\nImplement answered: The plan removes it.');
    expect(text.match(/Implement answered/g)).toHaveLength(1);
  });
});

describe('a reviewer decision', () => {
  it('is stored as the reviewer gave it, whatever the round', async () => {
    const finishVisit = jest.fn(async () => undefined);
    const deps = { visits: { finishVisit } } as unknown as ReviewDeps;
    const opened = { run: {} } as unknown as OpenedStep;
    const given = {
      decision: 'return' as const,
      review: 'Authentication is missing.',
      summary: [],
      reason: 'Still so.',
    };
    const item = {
      reviewer: { name: 'behavior', kind: 'review_behavior' },
      runtime: 'cursor',
      model: 'm',
      prompt: 'p',
      result: { startedAt: 's', finishedAt: 'f', durationMs: 1, tokensIn: 0, tokensOut: 0, usd: 0, samples: [] },
      parsed: opinionOf('review_behavior', given),
    } as unknown as Finished;
    await recordAngle(deps, opened, item);
    const [, visit] = finishVisit.mock.calls[0] as unknown as [
      unknown,
      { status: string; documents: { kind: string; body: string }[] },
    ];
    expect(visit.status).toBe('waiting');
    expect(visit.documents.map((document) => document.kind)).toEqual(['review_behavior', 'review_behavior_result']);
    expect(visit.documents[0].body).toBe('Authentication is missing.\ndecision: return\nreason: Still so.\n');
    expect(JSON.parse(visit.documents[1].body)).toEqual(given);
  });
});

describe('decision facts of a report visit', () => {
  const ctx = {
    opened: { startedAt: 'start', started: 0 },
    clock: { iso: () => 'end', now: () => 5 },
    end: async (result: unknown) => result,
  } as unknown as StepContext;

  it('lists the decision of each review from its stored result, and of an older run from its document', async () => {
    const sections = { quality: 'checked', security: 'checked' };
    const behaviorSections = { regressions: 'checked', performance: 'checked' };
    const result = (decision: 'ok' | 'return') => ({ decision, review: 'notes', summary: [], sections });
    const documents = [
      // The text says ok; the stored result says return.
      { kind: 'review_code', fileName: '', body: 'notes\ndecision: ok\n' },
      { kind: 'review_code_result', fileName: '', body: JSON.stringify(result('return')) },
      ...reviewDocuments(
        opinionOf('review_behavior', { decision: 'ok', review: 'notes', summary: [], sections: behaviorSections }),
      ),
      { kind: 'review_requirements', fileName: '', body: 'old run\ndecision: return\n' },
    ];
    const closed = (await closeReview(ctx, { to: 'next' }, 'line', documents, null)) as unknown as {
      facts: { details: string[] };
    };
    expect(closed.facts.details).toEqual(['code: return', 'behavior: ok', 'requirements: return']);
  });
});
