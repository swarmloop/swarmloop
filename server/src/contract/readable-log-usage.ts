/** Token counts travel on the final result line. Earlier lines do not carry them. */
export function usageFromLog(raw: string): { tokensIn: number; tokensOut: number } | null {
  let found: { tokensIn: number; tokensOut: number } | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"usage"')) {
      continue;
    }
    let record: { usage?: unknown };
    try {
      record = JSON.parse(trimmed) as { usage?: unknown };
    } catch {
      continue;
    }
    if (!isRecord(record.usage)) {
      continue;
    }
    const tokensIn = numberField(record.usage, ['inputTokens', 'input_tokens', 'prompt_tokens']);
    const tokensOut = numberField(record.usage, ['outputTokens', 'output_tokens', 'completion_tokens']);
    const cacheRead = numberField(record.usage, ['cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens']);
    const cacheWrite = numberField(record.usage, [
      'cacheWriteTokens',
      'cache_write_tokens',
      'cache_creation_input_tokens',
    ]);
    if (tokensIn === null && tokensOut === null && cacheRead === null && cacheWrite === null) {
      continue;
    }
    found = { tokensIn: (tokensIn ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0), tokensOut: tokensOut ?? 0 };
  }
  return found;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
