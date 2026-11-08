import { stepOutput } from '../core/attempt-output';
import type { ModelPrice } from './limits';
import { priceTokens } from './limits';
import { CODE_REVIEWERS } from '../contract/steps';
import { guessFromStream, usageFromStream } from './stream';

export interface Charge {
  tokensIn: number;
  tokensOut: number;
  usd: number;
  priced: boolean;
}

const REVIEWERS = CODE_REVIEWERS;

export function modelForStep(
  step: string,
  env: { MODEL_RESEARCH: string; MODEL_PLAN: string; MODEL_IMPLEMENT: string },
): string | null {
  if (
    step === 'research' ||
    step === 'plan' ||
    step === 'plan-improve' ||
    step === 'merge-request' ||
    step.startsWith('code-review-')
  ) {
    return env.MODEL_PLAN;
  }
  if (step === 'implement' || step === 'implement-improve') {
    return env.MODEL_IMPLEMENT;
  }
  return null;
}

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
  env: { MODEL_PLAN: string; MODEL_IMPLEMENT: string; MODEL_RESEARCH: string },
  table: Record<string, ModelPrice>,
  attemptId: string | null,
): Charge | null {
  let found = false;
  const total: Charge = { tokensIn: 0, tokensOut: 0, usd: 0, priced: true };
  for (const name of REVIEWERS) {
    const step = `code-review-${name}`;
    const model = modelForStep(step, env);
    if (!model) {
      continue;
    }
    const charge = chargeStream(model, stepOutput(root, key, step, attemptId), table);
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
