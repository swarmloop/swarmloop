import { parseResultBlock } from './result-block';

/** The skill example lives in the user prompt. Only the decision in the result block of the agent's own answer counts. */
export function agentDecision(raw: string): 'ok' | 'return' | null {
  const answer = raw
    .split('\n')
    .flatMap((line) => agentText(line) ?? [])
    .join('\n');
  const parsed = parseResultBlock(answer);
  const decision = parsed.ok ? parsed.value.decision : null;
  return decision === 'ok' || decision === 'return' ? decision : null;
}

function agentText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return line;
  }
  let record: { type?: unknown; result?: unknown; message?: { content?: unknown } };
  try {
    record = JSON.parse(trimmed) as { type?: unknown; result?: unknown; message?: { content?: unknown } };
  } catch {
    return line;
  }
  if (record.type === 'user') {
    return null;
  }
  if (typeof record.result === 'string') {
    return record.result;
  }
  const content = record.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('');
  return text.length > 0 ? text : null;
}
