import type { ModelPrice } from './limits';
import { type PricedRequest, RequestLedger } from './request-usage';
import { readStreamLine } from './stream';

/**
 * The model requests a stream file holds, one for each message id with its latest usage, each at its own model's
 * price. It is the same reading the launch does as the stream comes in, for a stream nobody read while it ran.
 */
export function requestsOfStream(
  raw: string,
  prices: Record<string, ModelPrice>,
  launchModel: string,
): PricedRequest[] {
  const ledger = new RequestLedger(prices, launchModel);
  const latest = new Map<string, PricedRequest>();
  for (const line of raw.split('\n')) {
    const request = readStreamLine(line)?.request;
    const taken = request ? ledger.add(request) : null;
    if (taken) {
      latest.set(taken.messageId, taken);
    }
  }
  return [...latest.values()];
}
