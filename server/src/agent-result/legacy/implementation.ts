// remove after runs started before f52 are gone
import type { ImplementationResult } from '../definitions/implementation';

/**
 * The items of a stored `implementation` document: a line starting with `- ` opens an item, and the lines indented by
 * two spaces that follow it are the rest of that item. A run that started before results were stored has only this.
 */
export function legacyImplementation(body: string): ImplementationResult {
  const items: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) {
      items.push(line.slice(2));
    } else if (items.length > 0 && line.startsWith('  ')) {
      items[items.length - 1] += `\n${line.slice(2)}`;
    }
  }
  return { implementation: items.map((item) => item.trimEnd()).filter((item) => item !== ''), summary: [] };
}
