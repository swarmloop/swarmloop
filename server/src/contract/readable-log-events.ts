export interface ParsedToolCall {
  label: string;
  detail: string;
  outcome: string;
  completed: boolean;
}

export type ReadableLogEvent =
  | { kind: 'ignore' }
  | { kind: 'close-speech' }
  | { kind: 'speech'; type: 'thinking' | 'assistant'; text: string }
  | { kind: 'result'; text: string }
  | { kind: 'tool'; call: ParsedToolCall | null }
  | { kind: 'block'; type: string; text: string | null };

export function commonEvent(record: Record<string, unknown>): ReadableLogEvent | null {
  if (record.type === 'system' || record.type === 'user') {
    return { kind: 'ignore' };
  }
  if (record.type === 'error') {
    return { kind: 'block', type: 'error', text: failureText(record) };
  }
  return null;
}

export function failureText(record: Record<string, unknown>): string | null {
  if (typeof record.message === 'string' && record.message.length > 0) {
    return record.message;
  }
  const error = record.error;
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (isRecord(error) && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
