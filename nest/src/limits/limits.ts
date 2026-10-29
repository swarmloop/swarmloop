import { StreamPiece, takeAnswer } from './stream';

export type KillReason = 'time' | 'idle' | 'usd' | 'tokens' | 'calls';

export interface LimitSnapshot {
  elapsedMs: number;
  idleMs: number;
  timeLimitMs: number;
  idleLimitMs: number;
  spentUsd: number;
  stepUsd: number;
  maxRunUsd: number;
  stepUsdMax: number | null;
  tokensInRun: number;
  stepTokens: number;
  maxRunTokens: number | null;
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
  const tokens = snapshot.tokensInRun + snapshot.stepTokens;
  if (
    (snapshot.maxRunTokens !== null && tokens >= snapshot.maxRunTokens) ||
    (snapshot.stepTokenMax !== null && snapshot.stepTokens >= snapshot.stepTokenMax)
  ) {
    return { kill: 'tokens', warn };
  }
  return { kill: null, warn };
}

/** A finished step may cross this. The next step does not start. */
export function overSpend(spentUsd: number, maxRunUsd: number): boolean {
  return maxRunUsd > 0 && spentUsd >= maxRunUsd;
}

export function callsExceeded(agentCalls: number, maxAgentCalls: number): boolean {
  return agentCalls >= maxAgentCalls;
}

/** Another launch after the process died before a decision. A limit kill, a stop, a result, or a decision in the model's answer stays down. */
export function retryCrash(input: {
  exitCode: number;
  killReason: KillReason | null;
  halted: boolean;
  callsSoFar: number;
  maxCalls: number;
  attempts: number;
  maxLaunches: number;
  decided: boolean;
}): boolean {
  if (input.exitCode === 0 || input.killReason !== null || input.halted || input.attempts >= input.maxLaunches || input.decided) {
    return false;
  }
  return !callsExceeded(input.callsSoFar, input.maxCalls);
}

/** Model text seen while the process was writing. A user message is the prompt, not a decision. */
export interface DecisionWatch {
  text: string;
  locked: boolean;
  stream: boolean;
  plain: boolean;
}

/** One line already read from the live stream. A user message is the prompt. */
export function noteDecision(state: DecisionWatch, piece: StreamPiece | null, line: string): DecisionWatch {
  if (!piece) {
    return !state.plain && decisionLine(line) ? { ...state, plain: true } : state;
  }
  if (piece.guessKind === 'user' || (!piece.text && !piece.finalMessage)) {
    return state.stream ? state : { ...state, stream: true };
  }
  const next = takeAnswer(state.text, state.locked, piece);
  return { text: next.text, locked: next.locked, stream: true, plain: state.plain };
}

/** True when the model already wrote a decision. An echoed prompt does not count. */
export function hasModelDecision(state: DecisionWatch): boolean {
  if (decisionLine(state.text)) {
    return true;
  }
  if (state.text.length > 0 || state.stream) {
    return false;
  }
  return state.plain;
}

function decisionLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const cleaned = line.trim().replace(/^[`*]+/, '').replace(/[`*]+$/, '').trim();
    return /^decision:\s*(ok|return|approve|revise)\s*$/.test(cleaned);
  });
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
}

/**
 * A resumed CLI total covers the whole chat. A smaller number is this turn alone.
 */
export function turnUsd(reported: number | null, priced: number, priorUsd: number, resumed: boolean): number {
  if (reported === null) {
    return priced;
  }
  if (!resumed || priorUsd <= 0 || reported < priorUsd) {
    return reported;
  }
  return reported - priorUsd;
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
  cacheWritePerMillion: number | null;
}

const EFFORT = /-(extra-high|xhigh|high|medium|low|thinking|max)$/;

export function priceTokens(
  model: string,
  tokensIn: number,
  tokensOut: number,
  table: Record<string, ModelPrice>,
  cacheRead = 0,
  cacheWrite = 0,
): number | null {
  const row = findPrice(model, table);
  if (!row) {
    return null;
  }
  const read = row.cacheReadPerMillion ?? 0;
  const write = row.cacheWritePerMillion ?? 0;
  return (tokensIn * row.inputPerMillion + cacheRead * read + cacheWrite * write + tokensOut * row.outputPerMillion) / 1_000_000;
}

function findPrice(model: string, table: Record<string, ModelPrice>): ModelPrice | null {
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

function canonical(value: string): string {
  return value.trim().toLowerCase().replace(/(\d)\.(\d)/g, '$1-$2').replace(EFFORT, '');
}
