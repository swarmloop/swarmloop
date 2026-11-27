import { runtimeFor, type RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { canonical, type ModelPrice } from './limits';

/** The cache lifetimes, in minutes, that the price page has a write column for. */
const FIVE_MINUTES = 5;
const ONE_HOUR = 60;

/**
 * Fills the cache rates the price page lacks from the prompt cache the runtime declares for the model, so no cache
 * token is priced at 0. A write is priced at the column of the cache the runtime declares; a page rate always wins over
 * the declared one. A model the runtime declares no cache for keeps the page's plain write rate, else its 1-hour or
 * 5-minute column, and a rate still missing is priced by `priceTokens`.
 */
export function withDeclaredCacheRates(
  prices: Record<string, ModelPrice>,
  runtime: RuntimeName,
): Record<string, ModelPrice> {
  const filled: Record<string, ModelPrice> = {};
  for (const [slug, row] of Object.entries(prices)) {
    const cache = runtimeFor(runtime).promptCache(canonical(slug));
    const declared =
      cache?.ttlMinutes === ONE_HOUR
        ? row.cacheWrite1hPerMillion
        : cache?.ttlMinutes === FIVE_MINUTES
          ? row.cacheWrite5mPerMillion
          : null;
    filled[slug] = {
      ...row,
      cacheReadPerMillion: row.cacheReadPerMillion ?? cache?.cacheReadPerMillion ?? null,
      cacheWritePerMillion: cache
        ? (declared ?? row.cacheWritePerMillion ?? cache.cacheWritePerMillion)
        : (row.cacheWritePerMillion ?? row.cacheWrite1hPerMillion ?? row.cacheWrite5mPerMillion ?? null),
    };
  }
  return filled;
}
