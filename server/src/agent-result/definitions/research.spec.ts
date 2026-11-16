import { readResult } from '../read-result';
import { resultPrompt } from '../result-prompt';
import { block } from '../result.spec-helpers';
import { research, researchFor } from './research';

const VALID = {
  summary: ['chose catalog-api'],
  questions: ['which field is optional?'],
  impact: [{ capability: 'stop button', file: 'stop.tsx', status: 'removed (named)' }],
  needs: [{ id: 'http-retry', what: 'the retry policy' }],
};

describe('research result', () => {
  it('reads a valid block', () => {
    expect(readResult(research, block(VALID))).toEqual({ ok: true, value: VALID });
  });

  it('leaves needs out', () => {
    const { needs: _needs, ...without } = VALID;
    expect(readResult(research, block(without))).toEqual({ ok: true, value: without });
  });

  it('reads a stored result that has no requirements', () => {
    expect(readResult(research, block(VALID))).toMatchObject({ ok: true });
  });

  it('requires at least one requirement of a run that is not a subtask', () => {
    expect(readResult(researchFor(false), block(VALID)).ok).toBe(false);
    expect(readResult(researchFor(false), block({ ...VALID, requirements: [] })).ok).toBe(false);
    expect(readResult(researchFor(false), block({ ...VALID, requirements: [{ id: 'R1', text: 'a' }] })).ok).toBe(true);
  });

  it('does not ask a subtask for requirements and reads an answer that sends them', () => {
    expect(readResult(researchFor(true), block(VALID)).ok).toBe(true);
    expect(readResult(researchFor(true), block({ ...VALID, requirements: [{ id: 'R1', text: 'a' }] })).ok).toBe(true);
    expect(resultPrompt(researchFor(true))).not.toContain('requirements');
    expect(resultPrompt(researchFor(false))).toContain('requirements');
  });

  it('rejects any other unknown key of a subtask answer, so no stored result fails the stored kind', () => {
    expect(readResult(researchFor(true), block({ ...VALID, stray: 1 })).ok).toBe(false);
    expect(readResult(researchFor(true), block({ ...VALID, requirements: 'x' })).ok).toBe(false);
  });

  it('names a status that is not one of the four', () => {
    const read = readResult(research, block({ ...VALID, impact: [{ capability: 'a', file: 'f', status: 'maybe' }] }));
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.errors[0]).toContain('impact.0.status');
  });

  it('names a missing capability', () => {
    const read = readResult(research, block({ ...VALID, impact: [{ file: 'f', status: 'kept' }] }));
    expect(read.ok === false && read.errors).toEqual(['impact.0.capability: "impact[0].capability" is required']);
  });

  it('names a missing block', () => {
    expect(readResult(research, 'no block here').ok).toBe(false);
  });

  it('keeps colons, nested lists, numbered lines, blank lines and code whole', () => {
    const text = 'is a: b?\n  - nested\n1. first\n\n```ts\nconst a = { b: 1 };\n```';
    const value = { ...VALID, questions: [text], impact: [{ capability: text, file: 'a: b.ts', status: 'kept' }] };
    expect(readResult(research, block(value))).toEqual({ ok: true, value });
  });
});
