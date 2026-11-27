import type { StreamPiece } from './stream';
import type { CacheWriteSplit } from './stream-usage';
import { parseResultBlock } from '../contract/result-block';
import { takeAnswer } from './stream';

export type KillReason = 'time' | 'idle' | 'usd' | 'tokens' | 'loop';

export interface LimitSnapshot {
  elapsedMs: number;
  idleMs: number;
  timeLimitMs: number;
  idleLimitMs: number;
  spentUsd: number;
  stepUsd: number;
  maxRunUsd: number;
  stepUsdMax: number | null;
  stepTokens: number;
  stepTokenMax: number | null;
  warned: boolean;
  enforceSpend?: boolean;
}

export function judgeLimits(snapshot: LimitSnapshot): { kill: KillReason | null; warn: boolean } {
  const timeWarn = snapshot.timeLimitMs > 0 && snapshot.elapsedMs >= snapshot.timeLimitMs * 0.8;
  const spendWarn = snapshot.maxRunUsd > 0 && snapshot.spentUsd + snapshot.stepUsd >= snapshot.maxRunUsd * 0.8;
  const warn = !snapshot.warned && (timeWarn || spendWarn);
  if (snapshot.elapsedMs >= snapshot.timeLimitMs) {
    return { kill: 'time', warn };
  }
  if (snapshot.idleMs >= snapshot.idleLimitMs) {
    return { kill: 'idle', warn };
  }
  if (snapshot.stepTokenMax !== null && snapshot.stepTokens >= snapshot.stepTokenMax) {
    return { kill: 'tokens', warn };
  }
  return { kill: null, warn };
}

/** A finished step may cross this. The next step does not start. */
export function overSpend(spentUsd: number, maxRunUsd: number): boolean {
  return maxRunUsd > 0 && spentUsd >= maxRunUsd;
}

/** Another launch after the process died before a decision. A limit kill, a stop, a result, or a decision in the model's answer stays down. */
export function retryCrash(input: {
  exitCode: number;
  killReason: KillReason | null;
  halted: boolean;
  attempts: number;
  maxLaunches: number;
  decided: boolean;
}): boolean {
  return (
    input.exitCode !== 0 &&
    input.killReason === null &&
    !input.halted &&
    input.attempts < input.maxLaunches &&
    !input.decided
  );
}

/** The answer text seen while the process was writing. A user message is the prompt, not an answer. */
export interface DecisionWatch {
  text: string;
  locked: boolean;
}

/** One line already read from the live stream. A user message is the prompt. */
export function noteDecision(state: DecisionWatch, piece: StreamPiece | null): DecisionWatch {
  if (!piece || piece.guessKind === 'user' || (!piece.text && !piece.finalMessage)) {
    return state;
  }
  return takeAnswer(state.text, state.locked, piece);
}

/**
 * True when the model already sent a result block that the step accepts. `answered` is the launcher's check of the
 * block against the step's schema. An echoed prompt does not count.
 */
export function hasModelDecision(state: DecisionWatch, answered: ((text: string) => boolean) | undefined): boolean {
  return answered !== undefined && parseResultBlock(state.text).ok && answered(state.text);
}

export interface SessionState {
  chatId: string | null;
  resumed: boolean;
  completed: boolean;
  killReason: KillReason | null;
  /** Agent that opened the chat. A different one cannot resume it. */
  runtime?: string;
  /** Dollars already charged for this chat, so a later turn does not add them again. */
  usd?: number;
  /** The last result definition sent to this chat; absent on sessions opened before result blocks. */
  resultName?: string;
}

export function shouldResume(session: SessionState | null, outputEmpty: boolean): boolean {
  if (!session || !outputEmpty || !session.chatId) {
    return false;
  }
  if (session.resumed || session.completed || session.killReason) {
    return false;
  }
  return true;
}

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number | null;
  /** The plain cache write price, or the price of the cache the runtime declares once the table is loaded. */
  cacheWritePerMillion: number | null;
  /** The write price of the 5-minute cache, when the page has such a column. */
  cacheWrite5mPerMillion?: number | null;
  /** The write price of the 1-hour cache, when the page has such a column. */
  cacheWrite1hPerMillion?: number | null;
}

const EFFORT = /-(extra-high|xhigh|high|medium|low|thinking|max)$/;

/**
 * The cost of tokens at a model's row. A cache rate the row lacks is priced at the input rate, never at 0. With the
 * split of `cacheWrite` by cache length each part is priced at its own column; any rest, or all of it without a split,
 * at the plain write rate.
 */
export function priceTokens(
  model: string,
  tokensIn: number,
  tokensOut: number,
  table: Record<string, ModelPrice>,
  cacheRead = 0,
  cacheWrite = 0,
  writes?: CacheWriteSplit,
): number | null {
  const row = findPrice(model, table);
  if (!row) {
    return null;
  }
  const read = row.cacheReadPerMillion ?? row.inputPerMillion;
  const write = row.cacheWritePerMillion ?? row.inputPerMillion;
  const fiveMinute = writes?.fiveMinute ?? 0;
  const oneHour = writes?.oneHour ?? 0;
  const rest = Math.max(0, cacheWrite - fiveMinute - oneHour);
  return (
    (tokensIn * row.inputPerMillion +
      cacheRead * read +
      fiveMinute * (row.cacheWrite5mPerMillion ?? write) +
      oneHour * (row.cacheWrite1hPerMillion ?? write) +
      rest * write +
      tokensOut * row.outputPerMillion) /
    1_000_000
  );
}

export function findPrice(model: string, table: Record<string, ModelPrice>): ModelPrice | null {
  if (table[model]) {
    return table[model];
  }
  const want = canonical(model);
  const hits = Object.entries(table)
    .filter(([slug]) => {
      const key = canonical(slug);
      return key === want || key.endsWith(`-${want}`);
    })
    .sort((left, right) => left[0].length - right[0].length);
  return hits[0]?.[1] ?? null;
}

export function canonical(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1-$2')
    .replace(EFFORT, '');
}
