const OPEN = '```json';
const CLOSE = '```';

/** The text of the last fenced `json` block of an answer, or null when it has none or the last one is not closed. */
export function findResultBlock(text: string): string | null {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const open = lines.lastIndexOf(OPEN);
  if (open < 0) {
    return null;
  }
  const close = lines.lastIndexOf(CLOSE);
  return close <= open ? null : lines.slice(open + 1, close).join('\n');
}

const NO_BLOCK = 'the answer has no result block';
const NOT_JSON = 'the result block is not valid JSON';
const NOT_OBJECT = 'the result block must be one JSON object';

/** True for an error text of `parseResultBlock`: the answer holds no object to check against the definition. */
export function isUnreadableBlockError(error: string): boolean {
  return [NO_BLOCK, NOT_JSON, NOT_OBJECT].some((text) => error.startsWith(text));
}

type ParsedBlock = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** The JSON object of the result block. The error says what is wrong in plain words. */
export function parseResultBlock(text: string): ParsedBlock {
  const block = findResultBlock(text);
  if (block === null) {
    return { ok: false, error: `${NO_BLOCK}: end it with a \`\`\`json block holding one JSON object` };
  }
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${NOT_JSON}: ${reason}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: NOT_OBJECT };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
