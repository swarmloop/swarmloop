import { CODE_REVIEWERS } from '../../contract/steps';
import { readResult } from '../read-result';
import { resultPrompt } from '../result-prompt';
import { block } from '../result.spec-helpers';
import { reviewDefinition } from './review';
import { reviewReport } from './review-report';

const REVIEW = {
  decision: 'return',
  review: 'The parser drops a segment.\n- a: b',
  summary: ['the parser drops a segment'],
};
const REPORT = { whatChanged: 'Parser fixed.', codeReview: 'All ok.' };

describe('review result', () => {
  it.each(CODE_REVIEWERS)('defines review_%s with its own kind', (name) => {
    expect(reviewDefinition(name).name).toBe(`review_${name}`);
    expect(reviewDefinition(name).kind).toBe(`review_${name}_result`);
  });

  it('reads a valid block', () => {
    expect(readResult(reviewDefinition('quality'), block(REVIEW))).toEqual({ ok: true, value: REVIEW });
  });

  it('names a decision that is neither ok nor return', () => {
    const read = readResult(reviewDefinition('quality'), block({ ...REVIEW, decision: 'approve' }));
    expect(read.ok === false && read.errors[0]).toContain('decision');
  });

  it('names every missing field', () => {
    const read = readResult(reviewDefinition('quality'), block({}));
    expect(read.ok === false && read.errors).toHaveLength(3);
  });

  it('takes the block, not the prose that says another decision', () => {
    const text = `decision: return\n\n${block({ ...REVIEW, decision: 'ok' })}`;
    expect(readResult(reviewDefinition('quality'), text)).toMatchObject({ ok: true, value: { decision: 'ok' } });
  });

  it('lists every field with its type and description in the prompt', () => {
    const prompt = resultPrompt(reviewDefinition('security'));
    expect(prompt).toContain('- decision (one of "ok", "return", required)');
    expect(prompt).toContain('- review (string, required)');
    expect(prompt).toContain('- summary (array of string, required)');
  });

  it('lets only the requirements review say where a behavior already is', () => {
    const value = { ...REVIEW, met: ['src/readme.ts: the field'] };
    expect(readResult(reviewDefinition('requirements'), block(value))).toEqual({ ok: true, value });
    expect(resultPrompt(reviewDefinition('requirements'))).toContain('- met (array of string, optional)');
    const read = readResult(reviewDefinition('quality'), block(value));
    expect(read.ok === false && read.errors[0]).toContain('met');
    expect(resultPrompt(reviewDefinition('quality'))).not.toContain('- met');
  });

  it('throws for a name that is not a reviewer', () => {
    expect(() => reviewDefinition('report')).toThrow('not a code reviewer');
  });
});

describe('review report result', () => {
  it('reads the required parts and the optional ones', () => {
    const value = { ...REPORT, requirements: '1. met', whatHolds: 'the parser', whatToFix: '- one' };
    expect(readResult(reviewReport, block(REPORT))).toEqual({ ok: true, value: REPORT });
    expect(readResult(reviewReport, block(value))).toEqual({ ok: true, value });
  });

  it('names a missing part and an empty one', () => {
    const read = readResult(reviewReport, block({ codeReview: '' }));
    expect(read.ok === false && read.errors.map((error) => error.split(':')[0]).sort()).toEqual([
      'codeReview',
      'whatChanged',
    ]);
  });

  it('lists every part in the prompt', () => {
    const prompt = resultPrompt(reviewReport);
    for (const field of ['requirements', 'whatChanged', 'codeReview', 'whatHolds', 'whatToFix']) {
      expect(prompt).toContain(`- ${field} (string`);
    }
  });
});
