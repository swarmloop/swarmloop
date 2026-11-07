export interface ParsedToolCall {
  label: string;
  detail: string;
  outcome: string;
  completed: boolean;
  /** Pairs a result with the call it answers, when the stream names the call. */
  id?: string;
  /** The exit code of a shell call, when the stream gives one. */
  exit?: number;
  failed?: boolean;
}

export type ReadableLogEvent =
  | { kind: 'ignore' }
  | { kind: 'close-speech' }
  | { kind: 'speech'; type: 'thinking' | 'assistant'; text: string }
  | { kind: 'result'; text: string }
  | { kind: 'tool'; call: ParsedToolCall | null }
  | { kind: 'block'; type: string; text: string | null }
  | { kind: 'many'; events: ReadableLogEvent[] };

/** The text of a tool result: a string, or the text parts of a list. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content.replace(/\s+$/, '');
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .replace(/\s+$/, '');
}

/** The label a tool has in the log, for the names a stream uses. */
export function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    bash: 'shell',
    command_execution: 'shell',
    read: 'read',
    edit: 'edit',
    multiedit: 'edit',
    write: 'edit',
    notebookedit: 'edit',
    file_change: 'edit',
  };
  return labels[name.toLowerCase()] ?? name.toLowerCase();
}

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
