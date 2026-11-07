import { resultText, toolLabel } from './readable-log-events';
import type { ParsedToolCall, ReadableLogEvent } from './readable-log-events';

export function claudeEvent(record: Record<string, unknown>): ReadableLogEvent | null {
  if (record.type === 'thinking') {
    if (record.subtype === 'completed') {
      return { kind: 'close-speech' };
    }
    return { kind: 'speech', type: 'thinking', text: typeof record.text === 'string' ? record.text : '' };
  }
  if (record.type === 'assistant') {
    return messageTools(record) ?? { kind: 'speech', type: 'assistant', text: textOf(record) ?? '' };
  }
  if (record.type === 'user') {
    return toolResults(record);
  }
  if (record.type === 'result') {
    return { kind: 'result', text: typeof record.result === 'string' ? record.result : '' };
  }
  if (record.type === 'tool_call') {
    return { kind: 'tool', call: openedTool(record) };
  }
  if (record.type === 'connection' || record.type === 'retry') {
    return { kind: 'block', type: record.type, text: eventText(record) };
  }
  return null;
}

function contentParts(record: Record<string, unknown>): Record<string, unknown>[] {
  const content = isRecord(record.message) ? record.message.content : null;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** An assistant message that calls tools: its text, then each call. Null when it calls none. */
function messageTools(record: Record<string, unknown>): ReadableLogEvent | null {
  const parts = contentParts(record);
  if (!parts.some((part) => part.type === 'tool_use')) {
    return null;
  }
  const events: ReadableLogEvent[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      events.push({ kind: 'speech', type: 'assistant', text: part.text });
    } else if (part.type === 'tool_use' && typeof part.name === 'string') {
      const label = toolLabel(part.name);
      const input = isRecord(part.input) ? part.input : {};
      const args = {
        command: input.command,
        pattern: input.pattern,
        path: input.file_path ?? input.path,
        globPattern: label === 'glob' ? input.pattern : undefined,
      };
      const id = typeof part.id === 'string' ? part.id : undefined;
      events.push({ kind: 'tool', call: { label, detail: argDetail(label, args), outcome: '', completed: false, id } });
    }
  }
  return { kind: 'many', events };
}

/** The results a user message carries for earlier calls. Null for a user message that is not one. */
function toolResults(record: Record<string, unknown>): ReadableLogEvent | null {
  const results = contentParts(record).filter((part) => part.type === 'tool_result');
  if (results.length === 0) {
    return null;
  }
  const events = results.map((part): ReadableLogEvent => {
    const outcome = resultText(part.content);
    const failed = part.is_error === true;
    const code = /^Exit code (\d+)/.exec(outcome)?.[1];
    return {
      kind: 'tool',
      call: {
        label: '',
        detail: '',
        outcome,
        completed: true,
        id: typeof part.tool_use_id === 'string' ? part.tool_use_id : undefined,
        exit: code ? Number(code) : failed ? 1 : 0,
        failed,
      },
    };
  });
  return { kind: 'many', events };
}

function textOf(record: Record<string, unknown>): string | null {
  if (typeof record.result === 'string') {
    return record.result;
  }
  const message = record.message;
  if (!isRecord(message)) {
    return null;
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  return text === '' ? null : text;
}

function eventText(record: Record<string, unknown>): string {
  const subtype = typeof record.subtype === 'string' ? record.subtype : '';
  const attempt = typeof record.attempt === 'number' ? `attempt ${record.attempt}` : '';
  return [subtype, attempt].filter((part) => part !== '').join(', ');
}

function openedTool(record: Record<string, unknown>): ParsedToolCall | null {
  const call = record.tool_call;
  if (!isRecord(call)) {
    return null;
  }
  const entry = Object.entries(call).find(
    ([, body]) => isRecord(body) && (isRecord(body.args) || isRecord(body.result) || body.rejected !== undefined),
  );
  if (!entry) {
    return null;
  }
  const [name, body] = entry;
  const label = name
    .replace(/ToolCall$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const args = isRecord(body) && isRecord(body.args) ? body.args : {};
  const result = isRecord(body) && isRecord(body.result) ? body.result : null;
  const success = result && isRecord(result.success) ? result.success : null;
  const exit = typeof success?.exitCode === 'number' ? success.exitCode : undefined;
  return {
    label,
    detail: argDetail(label, args),
    outcome: record.subtype === 'completed' ? outcome(isRecord(body) ? body.result : null) : '',
    completed: record.subtype === 'completed',
    exit,
    failed: Boolean(result?.rejected || result?.error || success?.error || (exit !== undefined && exit !== 0)),
  };
}

function argDetail(label: string, args: Record<string, unknown>): string {
  if (label === 'shell' && typeof args.command === 'string') {
    return args.command;
  }
  if (label === 'grep' && typeof args.pattern === 'string') {
    const path = typeof args.path === 'string' ? ` ${args.path}` : '';
    return `${args.pattern}${path}`;
  }
  if (typeof args.path === 'string') {
    return args.path;
  }
  if (typeof args.targetDirectory === 'string' || typeof args.globPattern === 'string') {
    return [args.targetDirectory, args.globPattern].filter((part) => typeof part === 'string').join(' ');
  }
  return '';
}

function outcome(result: unknown): string {
  if (!isRecord(result)) {
    return '';
  }
  if (result.rejected) {
    return 'rejected';
  }
  const success = isRecord(result.success) ? result.success : null;
  if (success && typeof success.totalFiles === 'number') {
    return `${success.totalFiles} files`;
  }
  if (success && typeof success.stdout === 'string' && success.stdout.trim() !== '') {
    return success.stdout.replace(/\s+$/, '');
  }
  if (success && typeof success.exitCode === 'number' && success.exitCode !== 0) {
    return `exit ${success.exitCode}`;
  }
  const error = result.error ?? success?.error;
  if (typeof error === 'string' && error !== '') {
    return error.replace(/\s+$/, '');
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
