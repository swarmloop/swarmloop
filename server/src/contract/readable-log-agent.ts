/** The skill example lives in the user prompt. Only the agent's own decision line counts. */
export function agentDecision(raw: string): 'ok' | 'return' | null {
  let found: 'ok' | 'return' | null = null;
  for (const line of raw.split('\n')) {
    const text = agentText(line);
    if (!text) {
      continue;
    }
    for (const row of text.split('\n')) {
      const cleaned = row
        .trim()
        .replace(/^[`*]+/, '')
        .replace(/[`*]+$/, '')
        .trim();
      const match = /^decision:\s*(ok|return)[`*]*(?:\s*[-–—:.,;]\s*\S.*)?\s*$/.exec(cleaned);
      if (match?.[1] === 'ok' || match?.[1] === 'return') {
        found = match[1];
      }
    }
  }
  return found;
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
