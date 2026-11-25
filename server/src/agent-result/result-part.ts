import { requiredByOf } from './required-by';
import type { RequiredBy } from './required-by';
import type { ResultDefinition } from './result-definition';
import { describeResult, fieldLine, typeOf } from './result-prompt';
import type { Described } from './result-prompt';

/** The line of each choice: the fields it needs, with their types. */
function needsLines(node: Described, table: RequiredBy): string[] {
  return Object.entries(table.needs).map(([choice, fields]) => {
    const list = fields.map((field) => `${field} (${node.keys?.[field] ? typeOf(node.keys[field]) : 'any'})`);
    return `- ${choice} needs: ${list.length > 0 ? list.join(', ') : 'nothing'}`;
  });
}

/**
 * The lines of the part of a definition that an error path names, written as the first prompt writes it, or null when
 * the path names no part. A numeric segment of an array steps into the items of the array.
 */
export function definitionPart(definition: ResultDefinition, errorPath: string): string[] | null {
  let node = describeResult(definition);
  let parent: Described | undefined;
  let key = '';
  let display = '';
  for (const segment of errorPath.split('.')) {
    if (node.type === 'array' && /^\d+$/.test(segment) && node.items?.[0]) {
      parent = undefined;
      node = node.items[0];
      display += '[]';
    } else if (node.keys?.[segment]) {
      parent = node;
      node = node.keys[segment];
      key = segment;
      display = display ? `${display}.${segment}` : segment;
    } else {
      return null;
    }
  }
  if (display === '') {
    return null;
  }
  const own = requiredByOf(node);
  if (own) {
    return needsLines(node, own);
  }
  const lines = [fieldLine(display, node)];
  const table = parent && requiredByOf(parent);
  if (parent && table?.field === key) {
    lines.push(...needsLines(parent, table));
  }
  return lines;
}
