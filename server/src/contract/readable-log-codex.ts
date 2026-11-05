import { failureText } from './readable-log-events';
import type { ReadableLogEvent } from './readable-log-events';

export function codexEvent(record: Record<string, unknown>): ReadableLogEvent | null {
  if (record.type === 'item.completed') {
    const item = record.item;
    if (isRecord(item) && item.type === 'agent_message' && typeof item.text === 'string') {
      return { kind: 'speech', type: 'assistant', text: item.text };
    }
    return { kind: 'ignore' };
  }
  if (record.type === 'turn.failed') {
    return { kind: 'block', type: 'turn.failed', text: failureText(record) };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
