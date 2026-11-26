import type { PricedRequest } from '../../agent/request-usage';
import { uncountedUsage } from './uncounted-usage';

const PRICE = { inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 1, cacheWritePerMillion: 5 };

function request(id: string, model: string, input: number, usd: number): PricedRequest {
  return {
    messageId: id,
    model,
    parentToolUseId: null,
    input,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    usd,
    price: PRICE,
  };
}

describe('uncountedUsage', () => {
  it('leaves what the rows count and keeps the rest of each model, at the price of its requests', () => {
    const owed = uncountedUsage(
      [request('a', 'opus', 100, 1), request('b', 'opus', 50, 0.5), request('c', 'sonnet', 10, 0.1)],
      [{ model: 'opus', input: 100, cacheRead: 0, cacheWrite: 0, output: 0, usd: 1 }],
    );
    expect(owed).toEqual([
      expect.objectContaining({ model: 'opus', input: 50, usd: 0.5, price: PRICE }),
      expect.objectContaining({ model: 'sonnet', input: 10, usd: 0.1 }),
    ]);
  });

  it('owes nothing for a model the rows count in full or beyond', () => {
    expect(
      uncountedUsage(
        [request('a', 'opus', 100, 1)],
        [
          { model: 'opus', input: 60, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0.6 },
          { model: 'opus', input: 90, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0.9 },
        ],
      ),
    ).toEqual([]);
  });
});
