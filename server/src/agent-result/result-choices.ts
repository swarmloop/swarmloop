import { needsLines } from './result-part';
import { requiredByOf } from './required-by';
import type { ResultDefinition } from './result-definition';
import { describeResult, fieldLines } from './result-prompt';
import type { Described } from './result-prompt';

/**
 * The lines of the array of choices at `path` (like `actions`), written from the described schema: one line for each
 * choice with the fields it needs and may also give, then the line of every field of the item, nested fields included.
 * Empty when the path names no array of choice objects.
 */
export function choiceList(definition: ResultDefinition, path: string): string[] {
  let node: Described | undefined = describeResult(definition);
  for (const key of path.split('.')) {
    node = node?.keys?.[key];
  }
  const item = node?.type === 'array' ? node.items?.[0] : undefined;
  const table = item && requiredByOf(item);
  if (!item || !table) {
    return [];
  }
  const lines = needsLines(item, table);
  for (const [key, child] of Object.entries(item.keys ?? {})) {
    fieldLines(`${path}[].${key}`, child, lines);
  }
  return lines;
}
