import { failureText, toolLabel } from './readable-log-events';
import type { ParsedToolCall, ReadableLogEvent } from './readable-log-events';

export function codexEvent(record: Record<string, unknown>): ReadableLogEvent | null {
  if (record.type === 'item.started' || record.type === 'item.completed') {
    const item = record.item;
    const completed = record.type === 'item.completed';
    if (completed && isRecord(item) && item.type === 'agent_message' && typeof item.text === 'string') {
      return { kind: 'speech', type: 'assistant', text: item.text };
    }
    const call = isRecord(item) ? codexTool(item, completed) : null;
    return call ? { kind: 'tool', call } : { kind: 'ignore' };
  }
  if (record.type === 'turn.failed') {
    return { kind: 'block', type: 'turn.failed', text: failureText(record) };
  }
  return null;
}

/** A command or a file change of a Codex turn. Other items are not tool calls. */
function codexTool(item: Record<string, unknown>, completed: boolean): ParsedToolCall | null {
  const id = typeof item.id === 'string' ? item.id : undefined;
  if (item.type === 'command_execution' && typeof item.command === 'string') {
    const exit = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output.replace(/\s+$/, '') : '';
    return {
      label: toolLabel(item.type),
      detail: item.command,
      outcome: completed ? output : '',
      completed,
      id,
      exit,
      failed: exit !== undefined && exit !== 0,
    };
  }
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    const paths = item.changes
      .map((change) => (isRecord(change) && typeof change.path === 'string' ? change.path : ''))
      .filter((path) => path !== '');
    return { label: toolLabel(item.type), detail: paths.join(', '), outcome: '', completed, id };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
