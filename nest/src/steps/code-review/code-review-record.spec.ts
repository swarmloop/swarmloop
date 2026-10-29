import { SwarmloopError } from '../../swarmloop-error';
import { parseReview, reviewDecision } from './code-review-record';

describe('parseReview', () => {
  it('reads a plain decision line', () => {
    expect(parseReview('notes\ndecision: ok\n').decision).toBe('ok');
    expect(parseReview('notes\ndecision: return\n').decision).toBe('return');
  });

  it('keeps the last decision when a resumed answer repeats one', () => {
    expect(parseReview('notes\ndecision: ok\nlater\ndecision: return\n').decision).toBe('return');
  });

  it('reads a backticked or bold decision line', () => {
    expect(parseReview('notes\n`decision: ok`\n').decision).toBe('ok');
    expect(parseReview('notes\n**decision: return**\n').decision).toBe('return');
  });

  it('keeps the later stream decision when an earlier attempt wrote a plain one', () => {
    const stream = `notes\ndecision: return\n${JSON.stringify({ type: 'result', result: 'cleared\ndecision: ok\n' })}\n`;
    expect(parseReview(stream).decision).toBe('ok');
    expect(reviewDecision(stream)).toBe('ok');
  });

  it('reads the decision from a result line in the stream', () => {
    const stream = `${JSON.stringify({ type: 'assistant', timestamp_ms: 1, message: { content: [{ type: 'text', text: 'look' }] } })}\n${JSON.stringify({ type: 'result', result: 'notes\n`decision: ok`\n' })}\n`;
    expect(parseReview(stream).decision).toBe('ok');
    expect(reviewDecision(stream)).toBe('ok');
  });

  it('does not treat the skill example in the prompt as a decision', () => {
    const stream = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Read the diff.\n\ndecision: ok\n' }] } })}\n`;
    expect(() => parseReview(stream)).toThrow(new SwarmloopError('decision is missing'));
  });

  it('rejects a missing decision', () => {
    expect(() => parseReview('notes only\n')).toThrow(new SwarmloopError('decision is missing'));
  });
});
