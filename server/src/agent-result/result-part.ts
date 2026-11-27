import { requiredByOf } from './required-by';
import type { RequiredBy } from './required-by';
import type { ResultDefinition } from './result-definition';
import { describeResult, fieldLine, typeOf } from './result-prompt';
import type { Described } from './result-prompt';

/** The fields of a list, written as `name (type)`. */
function typedFields(node: Described, fields: string[]): string {
  return fields.map((field) => `${field} (${node.keys?.[field] ? typeOf(node.keys[field]) : 'any'})`).join(', ');
}

/** The line of each choice: the fields it needs, and those it may also give, with their types. */
export function needsLines(node: Described, table: RequiredBy): string[] {
  return Object.entries(table.needs).map(([choice, fields]) => {
    const needs = fields.length > 0 ? typedFields(node, fields) : 'nothing';
    const takes = table.takes?.[choice] ?? [];
    return `- ${choice} needs: ${needs}${takes.length > 0 ? `; may also give: ${typedFields(node, takes)}` : ''}`;
  });
}

/** The keys an object takes, and when it is a choice object the fields of each choice. */
function takesOnly(display: string, node: Described, keys: string[]): string[] {
  const own = requiredByOf(node);
  return [
    `- ${display || 'the result'} takes only these keys: ${keys.join(', ')}`,
    ...(own ? needsLines(node, own) : []),
  ];
}

/**
 * The lines of the part of a definition that an error path names, written as the first prompt writes it, or null when
 * the path names no part. A numeric segment of an array steps into the items of the array. A last segment that is no
 * key of an object is a key the object does not take; the part is the list of the keys it takes.
 */
export function definitionPart(definition: ResultDefinition, errorPath: string): string[] | null {
  let node = describeResult(definition);
  let parent: Described | undefined;
  let key = '';
  let display = '';
  const segments = errorPath.split('.');
  for (const [index, segment] of segments.entries()) {
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
      return index === segments.length - 1 && node.keys ? takesOnly(display, node, Object.keys(node.keys)) : null;
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
