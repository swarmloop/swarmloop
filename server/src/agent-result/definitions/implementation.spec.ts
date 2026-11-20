import { readResult } from '../read-result';
import { resultPrompt } from '../result-prompt';
import { block } from '../result.spec-helpers';
import { implementationAfterReview, implementationFor } from './implementation';
import { implementationImproveAfterReview, implementationImproveFor } from './implementation-improve';

const VALID = { implementation: ['changed'], summary: ['why'] };
const HANDED = {
  question: 'Cursor or page number?',
  decisions: [{ item: 'cursor', text: 'opaque string' }],
  outOfScope: [{ what: 'the cache', needed: false }],
};

describe.each([
  ['implementation', implementationFor, implementationAfterReview],
  ['implementation-improve', implementationImproveFor, implementationImproveAfterReview],
])('the %s result a subtask hands back', (_name, asked, stored) => {
  it('tells a subtask about question, decisions and outOfScope, and reads them', () => {
    const subtask = asked({ subtask: true, review: false });
    const prompt = resultPrompt(subtask);
    expect(prompt).toContain('decisions');
    expect(prompt).toContain('outOfScope');
    expect(readResult(subtask, block({ ...VALID, ...HANDED }))).toMatchObject({ ok: true });
  });

  it('gives a run that is not a subtask the schema it had: its question, no decisions', () => {
    const plain = asked({ subtask: false, review: false });
    expect(resultPrompt(plain)).toContain('question');
    expect(resultPrompt(plain)).not.toContain('outOfScope');
    expect(readResult(plain, block({ ...VALID, question: 'x' }))).toMatchObject({ ok: true });
    expect(readResult(plain, block({ ...VALID, ...HANDED })).ok).toBe(false);
  });

  it('asks for rejected only after a review, and reads every field in the stored kind', () => {
    expect(resultPrompt(asked({ subtask: false, review: true }))).toContain('rejected');
    expect(resultPrompt(asked({ subtask: false, review: false }))).not.toContain('rejected');
    expect(readResult(stored, block({ ...VALID, ...HANDED, rejected: [] }))).toMatchObject({ ok: true });
  });
});
