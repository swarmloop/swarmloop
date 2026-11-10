import { stepOutput } from '../core/attempt-output';
import type { ModelPrice } from './limits';
import { priceTokens } from './limits';
import { CODE_REVIEWERS } from '../contract/steps';
import { agentFor } from '../config/agents';
import type { AgentEnv } from '../config/agents';
import { guessFromStream, usageFromStream } from './stream';

export interface Charge {
  tokensIn: number;
  tokensOut: number;
  usd: number;
  priced: boolean;
}

const REVIEWERS = CODE_REVIEWERS;

/** Prompt-side tokens include cache. Dollars use the provider cost when the stream has one, otherwise the price table. */
export function chargeStream(model: string, raw: string, table: Record<string, ModelPrice>): Charge | null {
  const usage = usageFromStream(raw);
  if (usage) {
    const priced = priceTokens(model, usage.input, usage.output, table, usage.cacheRead, usage.cacheWrite);
    const known = usage.reportedUsd !== null || priced !== null;
    return {
      tokensIn: usage.input + usage.cacheRead + usage.cacheWrite,
      tokensOut: usage.output,
      usd: usage.reportedUsd ?? priced ?? 0,
      priced: known,
    };
  }
  const guess = guessFromStream(raw);
  if (!guess) {
    return null;
  }
  const priced = priceTokens(model, guess.input, guess.output, table);
  return {
    tokensIn: guess.input,
    tokensOut: guess.output,
    usd: priced ?? 0,
    priced: priced !== null,
  };
}

export function chargeReview(
  root: string,
  key: string,
  env: AgentEnv,
  table: Record<string, ModelPrice>,
  attemptId: string | null,
): Charge | null {
  let found = false;
  const total: Charge = { tokensIn: 0, tokensOut: 0, usd: 0, priced: true };
  for (const name of REVIEWERS) {
    const step = `code-review-${name}` as const;
    const charge = chargeStream(agentFor(env, null, step).model, stepOutput(root, key, step, attemptId), table);
    if (!charge) {
      continue;
    }
    found = true;
    total.tokensIn += charge.tokensIn;
    total.tokensOut += charge.tokensOut;
    total.usd += charge.usd;
    total.priced = total.priced && charge.priced;
  }
  return found ? total : null;
}
