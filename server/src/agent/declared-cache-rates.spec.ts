import type { ModelPrice } from './limits';
import { withDeclaredCacheRates } from './declared-cache-rates';

function row(over: Partial<ModelPrice> = {}): ModelPrice {
  return {
    inputPerMillion: 4,
    outputPerMillion: 20,
    cacheReadPerMillion: null,
    cacheWritePerMillion: null,
    cacheWrite5mPerMillion: null,
    cacheWrite1hPerMillion: null,
    ...over,
  };
}

describe('withDeclaredCacheRates', () => {
  it('fills a read and a write rate the page lacks from the cache Claude declares', () => {
    const [filled] = Object.values(withDeclaredCacheRates({ 'claude-opus-5.5': row() }, 'claude'));
    expect(filled).toMatchObject({ cacheReadPerMillion: 0.2, cacheWritePerMillion: 8 });
  });

  it('prices writes at the 1-hour column the runtime declares, over the 5-minute one', () => {
    const prices = { 'claude-opus-5.5': row({ cacheWrite5mPerMillion: 5, cacheWrite1hPerMillion: 9 }) };
    expect(withDeclaredCacheRates(prices, 'claude')['claude-opus-5.5']?.cacheWritePerMillion).toBe(9);
  });

  it('keeps a rate the page has over the declared one', () => {
    const prices = { 'claude-opus-5.5': row({ cacheReadPerMillion: 0.5, cacheWritePerMillion: 6 }) };
    expect(withDeclaredCacheRates(prices, 'claude')['claude-opus-5.5']).toMatchObject({
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6,
    });
  });

  it('leaves a row with no cache rates null for a runtime that declares no cache', () => {
    const filled = withDeclaredCacheRates({ 'gpt-5.5': row() }, 'codex');
    expect(filled['gpt-5.5']).toMatchObject({ cacheReadPerMillion: null, cacheWritePerMillion: null });
  });

  it('takes the plain write rate, else a column, when the runtime declares no cache', () => {
    const prices = {
      a: row({ cacheWrite5mPerMillion: 3 }),
      b: row({ cacheWritePerMillion: 2, cacheWrite1hPerMillion: 6 }),
    };
    const filled = withDeclaredCacheRates(prices, 'codex');
    expect([filled.a?.cacheWritePerMillion, filled.b?.cacheWritePerMillion]).toEqual([3, 2]);
  });
});
