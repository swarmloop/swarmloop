// remove after runs started before f52 are gone
import type { Need } from '../definitions/research';
import { legacyItems, legacySection } from './prose-lines';

/** The `needs:` section of an answer: one `- <id>: <what>` line per sibling task. A line of another shape is dropped. */
export function parseNeeds(text: string): Need[] {
  const found: Need[] = [];
  for (const line of legacyItems(legacySection(text, 'needs') ?? '')) {
    const match = /^`?([^\s:`]+)`?\s*:\s*(.+)$/.exec(line);
    if (match) {
      found.push({ id: match[1], what: match[2].trim() });
    }
  }
  return found;
}
