/** What one stream line adds to a usage guess. A stream piece has these fields. */
interface GuessedLine {
  guessKind: 'user' | 'output' | 'tool-result' | 'none';
  guessedIn: number;
  guessedOut: number;
}

interface UsageGuess {
  context: number;
  tokensIn: number;
  tokensOut: number;
  replay: boolean;
}

/** Cursor only puts usage on the result line. Live spend counts each model round until that line arrives. */
export function emptyUsageGuess(): UsageGuess {
  return { context: 0, tokensIn: 0, tokensOut: 0, replay: false };
}

/** `read` turns one stream line into its piece, so this file does not depend on the stream reader. */
export function guessFromStream(
  raw: string,
  read: (line: string) => GuessedLine | null,
): { input: number; output: number } | null {
  const state = emptyUsageGuess();
  let any = false;
  for (const line of raw.split('\n')) {
    const piece = read(line);
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

export function addGuessedLine(state: UsageGuess, piece: GuessedLine): void {
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

/** `text` is the message text of the record, which the stream reader finds. */
export function guessLineTokens(
  record: Record<string, unknown>,
  text: string | null,
): { kind: GuessedLine['guessKind']; tokensIn: number; tokensOut: number } {
  if (record.type === 'thinking') {
    return { kind: 'output', tokensIn: 0, tokensOut: tokensOf(typeof record.text === 'string' ? record.text : '') };
  }
  if (record.type === 'assistant') {
    return { kind: 'output', tokensIn: 0, tokensOut: tokensOf(text ?? '') };
  }
  if (record.type === 'user') {
    return { kind: 'user', tokensIn: tokensOf(text ?? ''), tokensOut: 0 };
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
