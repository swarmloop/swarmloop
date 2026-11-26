import type { PricedRequest } from '../../agent/request-usage';
import type { ModelPrice, ModelUsage, RequestUsage } from '../../history/agent-call';

const EPSILON = 1e-9;

/** The price row of a request as the log keeps it: the rates its table knows. */
export function loggedPrice(price: PricedRequest['price']): ModelPrice {
  return Object.fromEntries<number>(
    Object.entries(price ?? {}).filter((entry): entry is [string, number] => entry[1] !== null),
  );
}

function empty(model: string, price: ModelPrice): RequestUsage {
  return { model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, price };
}

function sumOf<Entry extends ModelUsage>(entries: Entry[], start: (entry: Entry) => RequestUsage) {
  const sums = new Map<string, RequestUsage>();
  for (const entry of entries) {
    const sum = sums.get(entry.model) ?? start(entry);
    sum.input += entry.input;
    sum.cacheRead += entry.cacheRead;
    sum.cacheWrite += entry.cacheWrite;
    sum.output += entry.output;
    sum.usd += entry.usd;
    sums.set(entry.model, sum);
  }
  return sums;
}

/**
 * What a stream's requests used beyond what the rows already count, for each model. A row counts the requests that
 * were read as they streamed, so the rest is what the stream held while no server read it.
 */
export function uncountedUsage(requests: PricedRequest[], counted: ModelUsage[]): RequestUsage[] {
  const streamed = sumOf(requests, (request) => empty(request.model, loggedPrice(request.price)));
  const known = sumOf(counted, (entry) => empty(entry.model, {}));
  const owed: RequestUsage[] = [];
  for (const [model, sum] of streamed) {
    const have = known.get(model);
    const left: RequestUsage = {
      ...sum,
      input: Math.max(0, sum.input - (have?.input ?? 0)),
      cacheRead: Math.max(0, sum.cacheRead - (have?.cacheRead ?? 0)),
      cacheWrite: Math.max(0, sum.cacheWrite - (have?.cacheWrite ?? 0)),
      output: Math.max(0, sum.output - (have?.output ?? 0)),
      usd: Math.max(0, sum.usd - (have?.usd ?? 0)),
    };
    if (left.input + left.cacheRead + left.cacheWrite + left.output > 0 || left.usd > EPSILON) {
      owed.push(left);
    }
  }
  return owed;
}
