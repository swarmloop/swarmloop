import { findPrice, type ModelPrice, priceTokens } from './limits';
import type { RawRequest } from './stream-usage';

/** A model request counted at the launch's price table. */
export interface PricedRequest {
  messageId: string;
  model: string;
  parentToolUseId: string | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  usd: number;
  /** The price row it was counted at, or null when the table has none for its model and the launch's model. */
  price: ModelPrice | null;
}

/** Prices a request at its own model's row; a model with no row is priced as the launch's model. */
function priceRequest(
  raw: RawRequest,
  messageId: string,
  prices: Record<string, ModelPrice>,
  launchModel: string,
): PricedRequest {
  const model = raw.model ?? launchModel;
  const priced = findPrice(model, prices) ? model : launchModel;
  const { input, output, cacheRead, cacheWrite } = raw;
  return {
    ...raw,
    messageId,
    model,
    usd: priceTokens(priced, input, output, prices, cacheRead, cacheWrite) ?? 0,
    price: findPrice(priced, prices),
  };
}

/** The requests of one launch, one entry per message id: a repeated id replaces the earlier usage. */
export class RequestLedger {
  private readonly requests = new Map<string, PricedRequest>();
  private turns = 0;

  constructor(
    private readonly prices: Record<string, ModelPrice>,
    private readonly launchModel: string,
    /** Put before the ids this ledger makes itself, so that the launches of one call never share one. */
    private readonly idPrefix = '',
  ) {}

  get size(): number {
    return this.requests.size;
  }

  /** Takes a request. Returns it priced when its id is new or its usage changed, null when it changes nothing. */
  add(raw: RawRequest): PricedRequest | null {
    const id = raw.messageId ?? `${this.idPrefix}turn-${(this.turns += 1)}`;
    const request = priceRequest(raw, id, this.prices, this.launchModel);
    return this.put(request) ? request : null;
  }

  /** Takes a request priced elsewhere. Returns false when its id is known with the same usage. */
  put(request: PricedRequest): boolean {
    const known = this.requests.get(request.messageId);
    if (known && sameUsage(known, request)) {
      return false;
    }
    this.requests.set(request.messageId, request);
    return true;
  }

  /** A request whose model and the launch's model have no price row costs nothing here. */
  hasUnpriced(): boolean {
    return [...this.requests.values()].some((request) => request.price === null);
  }

  totals(): { tokensIn: number; tokensOut: number; usd: number } {
    let tokensIn = 0;
    let tokensOut = 0;
    let usd = 0;
    for (const request of this.requests.values()) {
      tokensIn += request.input + request.cacheRead + request.cacheWrite;
      tokensOut += request.output;
      usd += request.usd;
    }
    return { tokensIn, tokensOut, usd };
  }
}

function sameUsage(left: PricedRequest, right: PricedRequest): boolean {
  return (
    left.input === right.input &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.output === right.output
  );
}
