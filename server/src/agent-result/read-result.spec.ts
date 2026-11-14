import { readResult, readResultFromOutput } from './read-result';
import { block, FENCE, sample } from './result.spec-helpers';

const valid = { title: 't', items: ['a: b', '1. c'], decision: 'ok' };

describe('readResult', () => {
  it('passes a valid block', () => {
    expect(readResult(sample, `Done.\n\n${block(valid)}`)).toEqual({ ok: true, value: valid });
  });

  it('returns the error of a missing block', () => {
    expect(readResult(sample, 'prose only')).toEqual({
      ok: false,
      errors: [expect.stringContaining('no result block')],
    });
  });

  it('returns the error of invalid JSON', () => {
    expect(readResult(sample, `${FENCE}json\n{nope\n${FENCE}`)).toEqual({
      ok: false,
      errors: [expect.stringContaining('not valid JSON')],
    });
  });

  it('returns every schema error at once: missing, wrong type, unknown key and bad enum', () => {
    const answer = readResult(sample, block({ items: 'x', decision: 'maybe', extra: 1 }));
    expect(answer).toEqual({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining('title: "title" is required'),
        expect.stringContaining('items: "items" must be an array'),
        expect.stringContaining('decision: "decision" must be one of [ok, return]'),
        expect.stringContaining('extra: "extra" is not allowed'),
      ]),
    });
    expect(answer.ok ? [] : answer.errors).toHaveLength(4);
  });

  it('names the path of a nested error', () => {
    const answer = readResult(sample, block({ ...valid, tasks: [{}] }));
    expect(answer).toEqual({ ok: false, errors: [expect.stringContaining('tasks.0.id: "tasks[0].id" is required')] });
  });

  it('reads the last block after an earlier json example', () => {
    const text = `Example:\n${block({ example: true })}\nResult:\n${block(valid)}`;
    expect(readResult(sample, text)).toEqual({ ok: true, value: valid });
  });
});

describe('readResultFromOutput', () => {
  it('reads the block of the final answer of a stored stream', () => {
    const output = [
      JSON.stringify({ type: 'system', session_id: 'c1' }),
      JSON.stringify({ type: 'result', result: `Done.\n${block(valid)}` }),
    ].join('\n');
    expect(readResultFromOutput(sample, output)).toEqual({ ok: true, value: valid });
  });

  it('reports a stream with no answer', () => {
    expect(readResultFromOutput(sample, '')).toEqual({
      ok: false,
      errors: [expect.stringContaining('no result block')],
    });
  });
});
