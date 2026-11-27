/** What a request wrote to the cache, by the length of the cache it went to. */
export interface CacheWriteSplit {
  fiveMinute: number;
  oneHour: number;
}

export interface OwnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Null when no model entry reports a cost. */
  usd: number | null;
}

/** One model's part of a visit's own usage. `usd` is null when the line reports no cost for it. */
export interface ModelUsage extends Omit<OwnUsage, 'usd'> {
  model: string;
  usd: number | null;
}

export function uncachedInput(record: Record<string, unknown>, usage: Record<string, unknown>): number | null {
  const input = numberFrom(usage, ['input_tokens', 'inputTokens', 'prompt_tokens']);
  if (record.type !== 'turn.completed' || input === null) {
    return input;
  }
  const cached = numberFrom(usage, ['cached_input_tokens']);
  return cached === null ? input : Math.max(0, input - cached);
}

export function cacheReadOf(record: Record<string, unknown>, usage: Record<string, unknown>): number | null {
  if (record.type === 'turn.completed') {
    return numberFrom(usage, ['cached_input_tokens']);
  }
  return numberFrom(usage, ['cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens']);
}

/** `model_usage_since_last_result` holds one entry per model. The piece's own usage is their sum. */
export function ownUsageOf(record: Record<string, unknown>): OwnUsage | null {
  const models = modelUsageOf(record);
  if (models.length === 0) {
    return null;
  }
  const sum = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite'): number =>
    models.reduce((total, entry) => total + entry[key], 0);
  const costs = models.map((entry) => entry.usd);
  return {
    input: sum('input'),
    output: sum('output'),
    cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'),
    usd: costs.every((cost) => cost === null) ? null : costs.reduce<number>((total, cost) => total + (cost ?? 0), 0),
  };
}

/** One entry per model of `model_usage_since_last_result`, so that each model can be priced at its own price. */
export function modelUsageOf(record: Record<string, unknown>): ModelUsage[] {
  const byModel = record.model_usage_since_last_result;
  if (!byModel || typeof byModel !== 'object') {
    return [];
  }
  return Object.entries(byModel as Record<string, unknown>).flatMap(([model, value]) => {
    if (!value || typeof value !== 'object') {
      return [];
    }
    const entry = value as Record<string, unknown>;
    return [
      {
        model,
        input: numberFrom(entry, ['inputTokens', 'input_tokens']) ?? 0,
        output: numberFrom(entry, ['outputTokens', 'output_tokens']) ?? 0,
        cacheRead: numberFrom(entry, ['cacheReadInputTokens', 'cache_read_input_tokens']) ?? 0,
        cacheWrite: numberFrom(entry, ['cacheCreationInputTokens', 'cache_creation_input_tokens']) ?? 0,
        usd: numberFrom(entry, ['costUSD', 'cost_usd']),
      },
    ];
  });
}

export function usageOf(record: Record<string, unknown>): Record<string, unknown> {
  const message = record.message;
  const nested = message && typeof message === 'object' ? (message as { usage?: unknown }).usage : undefined;
  return {
    ...(nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : {}),
    ...(record.usage && typeof record.usage === 'object' ? (record.usage as Record<string, unknown>) : {}),
  };
}

export function numberFrom(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/** One model request as a stream line states it. `messageId` and `model` are null when the line has none (a Codex turn). */
export interface RawRequest {
  messageId: string | null;
  model: string | null;
  parentToolUseId: string | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** The cache writes by cache length, when the line reports them; null for a Codex turn and a line without the split. */
  cacheWriteSplit: CacheWriteSplit | null;
  output: number;
}

/** The cache writes of a usage block by the length of the cache they went to, or null when it reports neither. */
function cacheWriteSplitOf(usage: Record<string, unknown>): CacheWriteSplit | null {
  const created = usage.cache_creation;
  if (!created || typeof created !== 'object') {
    return null;
  }
  const split = created as Record<string, unknown>;
  const fiveMinute = numberFrom(split, ['ephemeral_5m_input_tokens']);
  const oneHour = numberFrom(split, ['ephemeral_1h_input_tokens']);
  return fiveMinute === null && oneHour === null ? null : { fiveMinute: fiveMinute ?? 0, oneHour: oneHour ?? 0 };
}

/** A Claude assistant message or a Codex turn as one request. Null for every other line. */
export function readRawRequest(record: Record<string, unknown>): RawRequest | null {
  const usage = usageOf(record);
  if (record.type === 'turn.completed') {
    return requestOf(record, usage, null, null);
  }
  const message = record.message;
  if (record.type !== 'assistant' || !message || typeof message !== 'object') {
    return null;
  }
  const { id, model, usage: messageUsage } = message as { id?: unknown; model?: unknown; usage?: unknown };
  if (typeof id !== 'string' || !messageUsage || typeof messageUsage !== 'object') {
    return null;
  }
  const parent = typeof record.parent_tool_use_id === 'string' ? record.parent_tool_use_id : null;
  return requestOf(record, usage, id, typeof model === 'string' ? model : null, parent);
}

function requestOf(
  record: Record<string, unknown>,
  usage: Record<string, unknown>,
  messageId: string | null,
  model: string | null,
  parentToolUseId: string | null = null,
): RawRequest {
  return {
    messageId,
    model,
    parentToolUseId,
    input: uncachedInput(record, usage) ?? 0,
    cacheRead: cacheReadOf(record, usage) ?? 0,
    cacheWrite: numberFrom(usage, ['cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens']) ?? 0,
    cacheWriteSplit: record.type === 'turn.completed' ? null : cacheWriteSplitOf(usage),
    output: numberFrom(usage, ['output_tokens', 'outputTokens', 'completion_tokens']) ?? 0,
  };
}
