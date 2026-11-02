export interface StreamPiece {
  tokensIn: number | null;
  tokensOut: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reportedUsd: number | null;
  guessedIn: number;
  guessedOut: number;
  guessKind: 'user' | 'output' | 'tool-result' | 'none';
  result: boolean;
  /** The finished assistant message. Partials carry timestamp_ms and are not this. */
  finalMessage: boolean;
  chatId: string | null;
  text: string | null;
  replaceText: boolean;
}

export interface CountedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reportedUsd: number | null;
}

export function readStreamLine(line: string): StreamPiece | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const usage = usageOf(record);
  const text = textFrom(record);
  const guessed = guessLineTokens(record);
  return {
    tokensIn: numberFrom(usage, ['input_tokens', 'inputTokens', 'prompt_tokens']),
    tokensOut: numberFrom(usage, ['output_tokens', 'outputTokens', 'completion_tokens']),
    cacheRead: numberFrom(usage, ['cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens']),
    cacheWrite: numberFrom(usage, ['cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens']),
    reportedUsd: numberFrom(record, ['total_cost_usd', 'totalCostUsd', 'cost_usd']) ?? numberFrom(usage, ['total_cost_usd', 'totalCostUsd', 'cost_usd']),
    guessedIn: guessed.tokensIn,
    guessedOut: guessed.tokensOut,
    guessKind: guessed.kind,
    result: record.type === 'result',
    finalMessage: record.type === 'assistant' && !('timestamp_ms' in record) && text !== null,
    chatId: stringFrom(record, ['session_id', 'sessionId', 'chat_id', 'chatId']),
    text,
    replaceText: record.type === 'result' && text !== null,
  };
}

/** The finished assistant message is the step answer. A later result line does not replace it. */
export function takeAnswer(current: string, locked: boolean, piece: StreamPiece): { text: string; locked: boolean } {
  if (piece.finalMessage && piece.text) {
    return { text: piece.text, locked: true };
  }
  if (locked || !piece.text) {
    return { text: current, locked };
  }
  return { text: piece.replaceText ? piece.text : current + piece.text, locked };
}

/** Sums every result line. A resumed log is two calls, and each result is that call's own total. */
export function usageFromStream(raw: string): CountedUsage | null {
  const results: CountedUsage[] = [];
  let last: CountedUsage | null = null;
  for (const line of raw.split('\n')) {
    const piece = readStreamLine(line);
    if (!piece || !counted(piece)) {
      continue;
    }
    const row = {
      input: piece.tokensIn ?? 0,
      output: piece.tokensOut ?? 0,
      cacheRead: piece.cacheRead ?? 0,
      cacheWrite: piece.cacheWrite ?? 0,
      reportedUsd: piece.reportedUsd,
    };
    last = row;
    if (piece.result) {
      results.push(row);
    }
  }
  const rows = results.length > 0 ? results : last ? [last] : [];
  if (rows.length === 0) {
    return null;
  }
  const reported = rows.every((row) => row.reportedUsd !== null);
  return {
    input: rows.reduce((sum, row) => sum + row.input, 0),
    output: rows.reduce((sum, row) => sum + row.output, 0),
    cacheRead: rows.reduce((sum, row) => sum + row.cacheRead, 0),
    cacheWrite: rows.reduce((sum, row) => sum + row.cacheWrite, 0),
    reportedUsd: reported ? rows.reduce((sum, row) => sum + (row.reportedUsd ?? 0), 0) : null,
  };
}

function counted(piece: StreamPiece): boolean {
  return piece.tokensIn !== null || piece.tokensOut !== null || piece.cacheRead !== null || piece.cacheWrite !== null || piece.reportedUsd !== null;
}

export interface UsageGuess {
  context: number;
  tokensIn: number;
  tokensOut: number;
  replay: boolean;
}

/** Cursor only puts usage on the result line. Live spend counts each model round until that line arrives. */
export function emptyUsageGuess(): UsageGuess {
  return { context: 0, tokensIn: 0, tokensOut: 0, replay: false };
}

export function guessFromStream(raw: string): { input: number; output: number } | null {
  const state = emptyUsageGuess();
  let any = false;
  for (const line of raw.split('\n')) {
    const piece = readStreamLine(line);
    if (!piece || piece.guessKind === 'none') {
      continue;
    }
    addGuessedLine(state, piece);
    any = true;
  }
  if (!any || (state.tokensIn === 0 && state.tokensOut === 0)) {
    return null;
  }
  return { input: state.tokensIn, output: state.tokensOut };
}

export function addGuessedLine(state: UsageGuess, piece: StreamPiece): void {
  if (piece.guessKind === 'user') {
    state.context += piece.guessedIn;
    state.tokensIn += piece.guessedIn;
    return;
  }
  if (piece.guessKind === 'tool-result') {
    state.context += piece.guessedIn;
    state.replay = true;
    return;
  }
  if (piece.guessKind === 'output' && piece.guessedOut > 0) {
    if (state.replay) {
      state.tokensIn += state.context;
      state.replay = false;
    }
    state.tokensOut += piece.guessedOut;
    state.context += piece.guessedOut;
  }
}

function guessLineTokens(record: Record<string, unknown>): { kind: StreamPiece['guessKind']; tokensIn: number; tokensOut: number } {
  if (record.type === 'thinking') {
    return { kind: 'output', tokensIn: 0, tokensOut: tokensOf(typeof record.text === 'string' ? record.text : '') };
  }
  if (record.type === 'assistant') {
    return { kind: 'output', tokensIn: 0, tokensOut: tokensOf(textFrom(record) ?? '') };
  }
  if (record.type === 'user') {
    return { kind: 'user', tokensIn: tokensOf(textFrom(record) ?? ''), tokensOut: 0 };
  }
  if (record.type === 'tool_call') {
    const { args, result } = toolParts(record);
    if (record.subtype === 'completed') {
      return { kind: 'tool-result', tokensIn: tokensOf(result), tokensOut: 0 };
    }
    return { kind: 'output', tokensIn: 0, tokensOut: tokensOf(args) };
  }
  return { kind: 'none', tokensIn: 0, tokensOut: 0 };
}

function toolParts(record: Record<string, unknown>): { args: unknown; result: unknown } {
  const call = record.tool_call;
  if (!call || typeof call !== 'object') {
    return { args: null, result: null };
  }
  for (const body of Object.values(call as Record<string, unknown>)) {
    if (body && typeof body === 'object') {
      const item = body as { args?: unknown; result?: unknown };
      return { args: item.args ?? null, result: item.result ?? null };
    }
  }
  return { args: null, result: null };
}

function tokensOf(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function usageOf(record: Record<string, unknown>): Record<string, unknown> {
  const message = record.message;
  const nested = message && typeof message === 'object' ? (message as { usage?: unknown }).usage : undefined;
  return {
    ...(nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : {}),
    ...(record.usage && typeof record.usage === 'object' ? (record.usage as Record<string, unknown>) : {}),
  };
}

function numberFrom(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function stringFrom(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function textFrom(record: Record<string, unknown>): string | null {
  if (typeof record.result === 'string') {
    return record.result;
  }
  const message = record.message;
  if (!message || typeof message !== 'object') {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => {
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('');
  return text.length > 0 ? text : null;
}
