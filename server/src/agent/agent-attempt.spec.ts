import { reviewDefinition } from '../agent-result/definitions/review';
import { readResult } from '../agent-result/read-result';
import { resultAnswer } from '../testing/result-answer';
import { priceTokens } from './limits';
import { AttemptMeter } from './agent-attempt';

const prices = {
  'test-model': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1 },
};

function meter(resumed = false): AttemptMeter {
  return new AttemptMeter({ model: 'test-model', prices, groupUsd: 0, resumed });
}

/** One stream line, read the way the runner reads it: note the decision, then count the piece. */
function feed(attempt: AttemptMeter, line: string): void {
  const piece = attempt.ingest(line);
  if (piece) {
    attempt.count(piece);
  }
}

describe('AttemptMeter', () => {
  it('leaves a line out of the usage until it is counted', () => {
    const attempt = meter();
    const piece = attempt.ingest(JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 2 } }));
    if (!piece) {
      throw new Error('expected a stream event');
    }
    expect(attempt.billed().tokensIn).toBe(0);
    attempt.count(piece);
    expect(attempt.billed().tokensIn).toBe(10);
  });

  it('counts each usage field from the stream', () => {
    const attempt = meter();
    feed(
      attempt,
      JSON.stringify({
        type: 'result',
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
      }),
    );
    expect(attempt.billed()).toEqual({
      tokensIn: 18,
      tokensOut: 2,
      usd: priceTokens('test-model', 10, 2, prices, 5, 3),
    });
  });

  it('guesses from the text and prices the guess when the stream reports no usage', () => {
    const attempt = meter();
    feed(attempt, JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'a'.repeat(400) }] } }));
    const usage = attempt.billed();
    expect(usage.tokensIn).toBeGreaterThan(0);
    expect(usage.usd).toBeGreaterThan(0);
    expect(usage.usd).toBe(priceTokens('test-model', usage.tokensIn, usage.tokensOut, prices));
  });

  it('uses the reported usd when the stream gives one', () => {
    const attempt = meter();
    feed(
      attempt,
      JSON.stringify({ type: 'result', total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 2 } }),
    );
    expect(attempt.billed().usd).toBe(0.42);
  });

  it('reports a decision once the model sends a result block the step accepts', () => {
    const attempt = meter();
    const answered = (text: string): boolean => readResult(reviewDefinition('quality'), text).ok;
    expect(attempt.decided(answered)).toBe(false);
    const message = (text: string): string =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    feed(attempt, message('notes\ndecision: return\n'));
    expect(attempt.decided(answered)).toBe(false);
    feed(attempt, message(resultAnswer('notes', { decision: 'return', review: 'notes', summary: [] })));
    expect(attempt.decided(answered)).toBe(true);
  });

  it('locks the answer after the final message', () => {
    const attempt = meter();
    feed(attempt, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done.' }] } }));
    feed(
      attempt,
      JSON.stringify({ type: 'assistant', timestamp_ms: 2, message: { content: [{ type: 'text', text: 'more' }] } }),
    );
    expect(attempt.answer()).toBe('done.');
  });
});
