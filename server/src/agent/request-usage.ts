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

/** The usage of one model, summed over requests, each at its own price. */
export interface PricedModelUsage {
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  usd: number;
}

/** What a helper (one `parent_tool_use_id`) used on one model. */
export interface HelperUsage {
  parentToolUseId: string;
  model: string;
  usage: PricedModelUsage;
  usd: number;
}

/** A call's requests, per model, per helper, and the prices they were counted at. */
export interface RequestUsage {
  byModel: PricedModelUsage[];
  helpers: HelperUsage[];
  prices: Record<string, ModelPrice>;
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

  /** The main agent's own usage per model. A helper's requests are not in it. */
  byModel(): PricedModelUsage[] {
    return sumUsage([...this.requests.values()].filter((request) => request.parentToolUseId === null)).map(
      (entry) => entry.usage,
    );
  }

  helpers(): HelperUsage[] {
    return sumUsage([...this.requests.values()].filter((request) => request.parentToolUseId !== null)).map(
      ({ parentToolUseId, usage }) => ({
        parentToolUseId: parentToolUseId as string,
        model: usage.model,
        usage,
        usd: usage.usd,
      }),
    );
  }

  /** The price rows the requests were counted at, by model. */
  priceRows(): Record<string, ModelPrice> {
    const rows: Record<string, ModelPrice> = {};
    for (const request of this.requests.values()) {
      if (request.price) {
        rows[request.model] = request.price;
      }
    }
    return rows;
  }

  usage(): RequestUsage {
    return { byModel: this.byModel(), helpers: this.helpers(), prices: this.priceRows() };
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

function sumUsage(requests: PricedRequest[]): { parentToolUseId: string | null; usage: PricedModelUsage }[] {
  const sums = new Map<string, { parentToolUseId: string | null; usage: PricedModelUsage }>();
  for (const request of requests) {
    const key = `${request.parentToolUseId ?? ''}\u0000${request.model}`;
    const sum = sums.get(key) ?? {
      parentToolUseId: request.parentToolUseId,
      usage: { model: request.model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 },
    };
    sum.usage.input += request.input;
    sum.usage.cacheRead += request.cacheRead;
    sum.usage.cacheWrite += request.cacheWrite;
    sum.usage.output += request.output;
    sum.usage.usd += request.usd;
    sums.set(key, sum);
  }
  return [...sums.values()];
}

/** Folds the usage of the launches of one call: the same model, or the same helper on the same model, adds up. */
export function foldRequestUsage(base: RequestUsage | null, next: RequestUsage): RequestUsage {
  if (!base) {
    return next;
  }
  const byModel = sumModels([...base.byModel, ...next.byModel]);
  const helpers = [...base.helpers, ...next.helpers].reduce<HelperUsage[]>((merged, helper) => {
    const same = merged.find(
      (entry) => entry.parentToolUseId === helper.parentToolUseId && entry.model === helper.model,
    );
    if (!same) {
      return [...merged, { ...helper, usage: { ...helper.usage } }];
    }
    same.usage = sumModels([same.usage, helper.usage])[0];
    same.usd = same.usage.usd;
    return merged;
  }, []);
  return { byModel, helpers, prices: { ...base.prices, ...next.prices } };
}

function sumModels(entries: PricedModelUsage[]): PricedModelUsage[] {
  const sums = new Map<string, PricedModelUsage>();
  for (const entry of entries) {
    const sum = sums.get(entry.model) ?? {
      model: entry.model,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      usd: 0,
    };
    sum.input += entry.input;
    sum.cacheRead += entry.cacheRead;
    sum.cacheWrite += entry.cacheWrite;
    sum.output += entry.output;
    sum.usd += entry.usd;
    sums.set(entry.model, sum);
  }
  return [...sums.values()];
}
