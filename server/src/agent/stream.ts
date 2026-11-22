import type { ChatUsage } from '../history/chat-usage.repository';
import { guessLineTokens } from './stream-guess';
import { NO_USAGE, sinceRecorded } from './since-recorded';

export interface StreamPiece {
  tokensIn: number | null;
  tokensOut: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reportedUsd: number | null;
  /** The visit's own usage in a result line that reports it apart from the session total, summed over its models. */
  own: OwnUsage | null;
  guessedIn: number;
  guessedOut: number;
  guessKind: 'user' | 'output' | 'tool-result' | 'none';
  result: boolean;
  /** Cursor and Claude end the process with one result line. A Codex turn does not. */
  stops: boolean;
  /** A Codex turn reports its own tokens. A result line is the whole call and replaces them. */
  addUsage: boolean;
  /** The finished assistant message. Partials carry timestamp_ms and are not this. */
  finalMessage: boolean;
  chatId: string | null;
  /** A background task ended with `stopped` or `killed`. */
  taskEnded: boolean;
  /** A system task or background event: `ended` when every task in it is stopped or killed, `other` otherwise. */
  backgroundEvent: 'ended' | 'other' | null;
  text: string | null;
  replaceText: boolean;
}

export interface OwnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Null when no model entry reports a cost. */
  usd: number | null;
}

interface CountedUsage {
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
  const guessed = guessLineTokens(record, text);
  return {
    tokensIn: uncachedInput(record, usage),
    tokensOut: numberFrom(usage, ['output_tokens', 'outputTokens', 'completion_tokens']),
    cacheRead: cacheReadOf(record, usage),
    cacheWrite: numberFrom(usage, ['cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens']),
    reportedUsd:
      numberFrom(record, ['total_cost_usd', 'totalCostUsd', 'cost_usd']) ??
      numberFrom(usage, ['total_cost_usd', 'totalCostUsd', 'cost_usd']),
    own: ownUsageOf(record),
    guessedIn: guessed.tokensIn,
    guessedOut: guessed.tokensOut,
    guessKind: guessed.kind,
    result: record.type === 'result' || record.type === 'turn.completed',
    stops: record.type === 'result',
    addUsage: record.type === 'turn.completed',
    finalMessage: record.type === 'assistant' && !('timestamp_ms' in record) && text !== null,
    chatId:
      record.type === 'thread.started'
        ? stringFrom(record, ['thread_id'])
        : stringFrom(record, ['session_id', 'sessionId', 'chat_id', 'chatId']),
    taskEnded: isTaskNotification(record) && isEndedStatus(record.status),
    backgroundEvent: backgroundEventOf(record),
    text: record.type === 'item.completed' ? (agentMessage(record) ?? text) : (failureText(record) ?? text),
    replaceText: (record.type === 'result' && text !== null) || agentMessage(record) !== null,
  };
}

const BACKGROUND_SUBTYPES = ['task_notification', 'task_updated', 'background_tasks_changed'];

function isEndedStatus(status: unknown): boolean {
  return status === 'stopped' || status === 'killed';
}

function backgroundEventOf(record: Record<string, unknown>): StreamPiece['backgroundEvent'] {
  if (record.type !== 'system' || typeof record.subtype !== 'string' || !BACKGROUND_SUBTYPES.includes(record.subtype)) {
    return null;
  }
  const statuses = taskStatuses(record);
  return statuses.length > 0 && statuses.every(isEndedStatus) ? 'ended' : 'other';
}

/** Task statuses of a background event, from `status`, `patch.status` and `tasks[].status`. The summary text is never read. */
function taskStatuses(record: Record<string, unknown>): unknown[] {
  const patch = record.patch && typeof record.patch === 'object' ? (record.patch as { status?: unknown }) : {};
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  return [
    record.status,
    patch.status,
    ...tasks.map((task) => (task && typeof task === 'object' ? (task as { status?: unknown }).status : undefined)),
  ].filter((status) => status !== undefined);
}

function isTaskNotification(record: Record<string, unknown>): boolean {
  return record.type === 'system' && record.subtype === 'task_notification';
}

function uncachedInput(record: Record<string, unknown>, usage: Record<string, unknown>): number | null {
  const input = numberFrom(usage, ['input_tokens', 'inputTokens', 'prompt_tokens']);
  if (record.type !== 'turn.completed' || input === null) {
    return input;
  }
  const cached = numberFrom(usage, ['cached_input_tokens']);
  return cached === null ? input : Math.max(0, input - cached);
}

function cacheReadOf(record: Record<string, unknown>, usage: Record<string, unknown>): number | null {
  if (record.type === 'turn.completed') {
    return numberFrom(usage, ['cached_input_tokens']);
  }
  return numberFrom(usage, ['cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens']);
}

function agentMessage(record: Record<string, unknown>): string | null {
  const item = record.item;
  if (!item || typeof item !== 'object') {
    return null;
  }
  const message = item as { type?: unknown; text?: unknown };
  if (message.type !== 'agent_message' || typeof message.text !== 'string' || message.text.length === 0) {
    return null;
  }
  return message.text;
}

function failureText(record: Record<string, unknown>): string | null {
  if (record.type !== 'turn.failed' && record.type !== 'error') {
    return null;
  }
  if (typeof record.message === 'string' && record.message.length > 0) {
    return record.message;
  }
  const error = record.error;
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    const message = (error as { message: string }).message;
    return message.length > 0 ? message : null;
  }
  return null;
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

/**
 * Sums the visit's own usage of every result line. A line that reports it apart from the session total gives it as is.
 * Otherwise its total is taken against the chat's previous reported session totals, `prior` or those of the line
 * before it. A Codex turn reports its own tokens and is never reduced.
 */
export function usageFromStream(raw: string, prior: ChatUsage = NO_USAGE): CountedUsage | null {
  const results: CountedUsage[] = [];
  let last: CountedUsage | null = null;
  const recorded = { ...prior };
  for (const line of raw.split('\n')) {
    const piece = readStreamLine(line);
    if (!piece || !counted(piece)) {
      continue;
    }
    const row = piece.result && !piece.addUsage ? resultRow(piece, recorded) : totalsRow(piece);
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

function totalsRow(piece: StreamPiece): CountedUsage {
  return {
    input: piece.tokensIn ?? 0,
    output: piece.tokensOut ?? 0,
    cacheRead: piece.cacheRead ?? 0,
    cacheWrite: piece.cacheWrite ?? 0,
    reportedUsd: piece.reportedUsd,
  };
}

/** The visit's part of a result line. `recorded` is the chat's last reported session total and moves on to this line's. */
function resultRow(piece: StreamPiece, recorded: ChatUsage): CountedUsage {
  const total = totalsRow(piece);
  const own = piece.own;
  const prompt = total.input + total.cacheRead + total.cacheWrite;
  const row = own ? { ...own, reportedUsd: own.usd } : partOfTotal(total, prompt, recorded);
  if (!own || prompt > 0 || total.output > 0 || total.reportedUsd !== null) {
    recorded.tokensIn = prompt;
    recorded.tokensOut = total.output;
    recorded.usd = total.reportedUsd ?? 0;
  }
  return row;
}

function partOfTotal(total: CountedUsage, prompt: number, recorded: ChatUsage): CountedUsage {
  const promptOwn = sinceRecorded(prompt, recorded.tokensIn);
  const share = prompt > 0 ? promptOwn / prompt : 0;
  const cacheRead = Math.round(total.cacheRead * share);
  const cacheWrite = Math.round(total.cacheWrite * share);
  return {
    input: Math.max(0, promptOwn - cacheRead - cacheWrite),
    output: sinceRecorded(total.output, recorded.tokensOut),
    cacheRead,
    cacheWrite,
    reportedUsd: total.reportedUsd === null ? null : sinceRecorded(total.reportedUsd, recorded.usd),
  };
}

function counted(piece: StreamPiece): boolean {
  return (
    piece.tokensIn !== null ||
    piece.tokensOut !== null ||
    piece.cacheRead !== null ||
    piece.cacheWrite !== null ||
    piece.reportedUsd !== null ||
    piece.own !== null
  );
}

/** `model_usage_since_last_result` holds one entry per model. The piece's own usage is their sum. */
function ownUsageOf(record: Record<string, unknown>): OwnUsage | null {
  const byModel = record.model_usage_since_last_result;
  if (!byModel || typeof byModel !== 'object') {
    return null;
  }
  const entries = Object.values(byModel as Record<string, unknown>).filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object',
  );
  if (entries.length === 0) {
    return null;
  }
  const sum = (keys: string[]): number => entries.reduce((total, entry) => total + (numberFrom(entry, keys) ?? 0), 0);
  const costs = entries.map((entry) => numberFrom(entry, ['costUSD', 'cost_usd']));
  return {
    input: sum(['inputTokens', 'input_tokens']),
    output: sum(['outputTokens', 'output_tokens']),
    cacheRead: sum(['cacheReadInputTokens', 'cache_read_input_tokens']),
    cacheWrite: sum(['cacheCreationInputTokens', 'cache_creation_input_tokens']),
    usd: costs.every((cost) => cost === null) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0),
  };
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
