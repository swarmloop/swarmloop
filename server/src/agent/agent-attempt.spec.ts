import type { Logger } from '@nestjs/common';
import { reviewDefinition } from '../agent-result/definitions/review';
import { readResult } from '../agent-result/read-result';
import { resultAnswer } from '../testing/result-answer';
import { priceTokens } from './limits';
import { AttemptMeter } from './agent-attempt';
import { NO_USAGE, type ChatUsage } from './since-recorded';

const prices = {
  'test-model': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1 },
};

function meter(prior: ChatUsage = NO_USAGE): AttemptMeter {
  return new AttemptMeter({ model: 'test-model', prices, prior });
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
  describe('against what the chat already cost', () => {
    const prior = { usd: 3, tokensIn: 100, tokensOut: 20 };
    const session = (extra: Record<string, unknown> = {}): string =>
      JSON.stringify({
        type: 'result',
        total_cost_usd: 4,
        usage: { input_tokens: 90, cache_read_input_tokens: 30, output_tokens: 26 },
        ...extra,
      });

    it('bills the visit its own usage when the result line reports it', () => {
      const attempt = meter(prior);
      feed(
        attempt,
        session({
          model_usage_since_last_result: {
            a: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 10, cacheCreationInputTokens: 1, costUSD: 0.5 },
            b: { inputTokens: 1, outputTokens: 1, costUSD: 0.25 },
          },
        }),
      );
      expect(attempt.billed()).toEqual({ tokensIn: 17, tokensOut: 3, usd: 0.75 });
    });

    it('prices each model of a result line at its own price when the line reports no cost', () => {
      const attempt = new AttemptMeter({
        model: 'main',
        prior,
        prices: {
          main: { inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
          helper: { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0, cacheWritePerMillion: 0 },
        },
      });
      feed(
        attempt,
        session({
          model_usage_since_last_result: {
            main: { inputTokens: 1_000_000, outputTokens: 0 },
            helper: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
          },
        }),
      );
      expect(attempt.billed()).toEqual({ tokensIn: 3_000_000, tokensOut: 1_000_000, usd: 10 + 2 + 2 });
    });

    it('bills a session total as the difference to the recorded total', () => {
      const attempt = meter(prior);
      feed(attempt, session());
      expect(attempt.billed()).toEqual({ tokensIn: 20, tokensOut: 6, usd: 1 });
    });

    it('bills a total below the recorded one as the visit alone', () => {
      const attempt = meter({ usd: 9, tokensIn: 500, tokensOut: 90 });
      feed(attempt, session());
      expect(attempt.billed()).toEqual({ tokensIn: 120, tokensOut: 26, usd: 4 });
    });

    it('subtracts the recorded dollars from a priced total when the stream reports no cost', () => {
      const attempt = meter({ usd: 0.0001, tokensIn: 0, tokensOut: 0 });
      feed(attempt, JSON.stringify({ type: 'result', usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
      expect(attempt.billed().usd).toBeCloseTo(0.9999);
    });

    it('reports the session totals of the last result line, also from a line that reports its own part', () => {
      const attempt = meter(prior);
      expect(attempt.reported()).toBeNull();
      feed(
        attempt,
        session({ model_usage_since_last_result: { a: { inputTokens: 5, outputTokens: 2, costUSD: 0.5 } } }),
      );
      expect(attempt.reported()).toEqual({ tokensIn: 120, tokensOut: 26, usd: 4 });
      const codex = meter(prior);
      feed(codex, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 150, output_tokens: 30 } }));
      expect(codex.reported()).toBeNull();
    });

    it('does not reduce per-message usage before the result line', () => {
      const attempt = meter(prior);
      feed(
        attempt,
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 150, output_tokens: 30 } } }),
      );
      expect(attempt.billed()).toMatchObject({ tokensIn: 150, tokensOut: 30 });
    });

    it('does not reduce a Codex turn, which reports its own usage', () => {
      const attempt = meter(prior);
      feed(attempt, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 150, output_tokens: 30 } }));
      expect(attempt.billed()).toMatchObject({ tokensIn: 150, tokensOut: 30 });
    });
  });

  describe('from each model request', () => {
    const message = (id: string, usage: Record<string, number>): string =>
      JSON.stringify({ type: 'assistant', message: { id, model: 'test-model', usage } });
    const resultLine = (usd: number): string =>
      JSON.stringify({ type: 'result', total_cost_usd: usd, usage: { input_tokens: 1, output_tokens: 1 } });

    it('grows request by request and tells onRequest about each priced request', () => {
      const seen: { messageId: string; usd: number }[] = [];
      const attempt = new AttemptMeter({ model: 'test-model', prices, prior: NO_USAGE }, (request) =>
        seen.push({ messageId: request.messageId, usd: request.usd }),
      );
      feed(attempt, message('m1', { input_tokens: 1_000_000 }));
      expect(attempt.billed()).toEqual({ tokensIn: 1_000_000, tokensOut: 0, usd: 1 });
      feed(attempt, message('m2', { output_tokens: 1_000_000 }));
      expect(attempt.billed().usd).toBe(3);
      expect(seen).toEqual([
        { messageId: 'm1', usd: 1 },
        { messageId: 'm2', usd: 2 },
      ]);
    });

    it('keeps the requests of a call cut before the result line', () => {
      const attempt = meter();
      feed(attempt, message('m1', { input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }));
      expect(attempt.billed()).toMatchObject({ tokensIn: 2_000_000, usd: 2 });
    });

    it('costs a resumed chat its own requests, not the running total of the final line', () => {
      const attempt = meter({ usd: 5, tokensIn: 5_000_000, tokensOut: 0 });
      feed(attempt, message('m1', { input_tokens: 1_000_000 }));
      feed(
        attempt,
        JSON.stringify({ type: 'result', total_cost_usd: 6, usage: { input_tokens: 6_000_000, output_tokens: 0 } }),
      );
      expect(attempt.billed()).toEqual({ tokensIn: 1_000_000, tokensOut: 0, usd: 1 });
    });

    it('only cross-checks with the final line, and logs a gap of a cent or more once', () => {
      const warn = jest.fn();
      const attempt = new AttemptMeter({
        model: 'test-model',
        prices,
        prior: NO_USAGE,
        logger: { warn } as unknown as Logger,
      });
      feed(attempt, message('m1', { input_tokens: 1_000_000 }));
      feed(attempt, resultLine(1.5));
      feed(attempt, resultLine(1.5));
      expect(attempt.billed().usd).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('$1.5000');
    });

    it('stays quiet when the final line agrees with the requests', () => {
      const warn = jest.fn();
      const attempt = new AttemptMeter({
        model: 'test-model',
        prices,
        prior: NO_USAGE,
        logger: { warn } as unknown as Logger,
      });
      feed(attempt, message('m1', { input_tokens: 1_000_000 }));
      feed(attempt, resultLine(1.001));
      expect(warn).not.toHaveBeenCalled();
    });

    it('counts the final line as the requests of a stream with none, at settle', () => {
      const seen: { model: string; usd: number }[] = [];
      const attempt = new AttemptMeter({ model: 'test-model', prices, prior: NO_USAGE }, (request) =>
        seen.push({ model: request.model, usd: request.usd }),
      );
      feed(
        attempt,
        JSON.stringify({
          type: 'result',
          total_cost_usd: 0.75,
          usage: { input_tokens: 10, output_tokens: 2 },
          model_usage_since_last_result: {
            a: { inputTokens: 5, outputTokens: 2, costUSD: 0.5 },
            b: { inputTokens: 1, outputTokens: 1, costUSD: 0.25 },
          },
        }),
      );
      expect(seen).toEqual([]);
      attempt.settle();
      attempt.settle();
      expect(seen).toEqual([
        { model: 'a', usd: 0.5 },
        { model: 'b', usd: 0.25 },
      ]);
      expect(attempt.billed()).toEqual({ tokensIn: 6, tokensOut: 3, usd: 0.75 });
    });

    it('settles a session total less what the chat already cost as one request', () => {
      const seen: number[] = [];
      const attempt = new AttemptMeter(
        { model: 'test-model', prices, prior: { usd: 3, tokensIn: 100, tokensOut: 20 } },
        (r) => seen.push(r.usd),
      );
      feed(
        attempt,
        JSON.stringify({ type: 'result', total_cost_usd: 4, usage: { input_tokens: 120, output_tokens: 26 } }),
      );
      attempt.settle();
      expect(seen).toEqual([1]);
    });

    it('keeps the cost the final line reports when the price table has no row for the model', () => {
      const attempt = new AttemptMeter({ model: 'unknown', prices: {}, prior: NO_USAGE });
      feed(
        attempt,
        JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'unknown', usage: { input_tokens: 10 } } }),
      );
      expect(attempt.billed().usd).toBe(0);
      feed(
        attempt,
        JSON.stringify({ type: 'result', total_cost_usd: 0.4, usage: { input_tokens: 10, output_tokens: 1 } }),
      );
      expect(attempt.billed()).toMatchObject({ tokensIn: 10, usd: 0.4 });
    });

    it('gives the synthetic ids of the launches of one call different ids', () => {
      const ids: string[] = [];
      const turn = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
      for (const idPrefix of ['launch-0:', 'launch-1:']) {
        const attempt = new AttemptMeter({ model: 'test-model', prices, prior: NO_USAGE, idPrefix }, (request) =>
          ids.push(request.messageId),
        );
        feed(attempt, turn);
      }
      const cursor = new AttemptMeter(
        { model: 'test-model', prices, prior: NO_USAGE, idPrefix: 'launch-2:' },
        (request) => ids.push(request.messageId),
      );
      feed(cursor, JSON.stringify({ type: 'result', total_cost_usd: 1, usage: { input_tokens: 5, output_tokens: 1 } }));
      cursor.settle();
      expect(ids).toEqual(['launch-0:turn-1', 'launch-1:turn-1', 'launch-2:final:test-model']);
    });
  });
});
