// remove after runs started before f52 are gone
import { legacyItems, legacySection } from './prose-lines';

const IMPACT_STATUSES = ['kept', 'changed', 'removed', 'unreachable'] as const;

interface ImpactItem {
  capability: string;
  file: string;
  status: string;
}

/** The open questions of a stored `questions` document, or of the `questions:` section of an answer. `none` is no question. */
export function legacyQuestions(body: string): string[] {
  return legacyItems(body).filter((item) => item !== 'none');
}

/** The open questions of an answer. Throws when the section is missing. */
export function parseResearch(text: string): { questions: string[] } {
  const block = legacySection(text, 'questions');
  if (block === null) {
    throw new Error('questions is missing');
  }
  return { questions: legacyQuestions(block) };
}

/** The `impact:` list of an answer. A line that is not `<capability> | <file> | <status>` is dropped with a note. */
export function parseImpact(text: string): { items: ImpactItem[]; notes: string[] } {
  const found: ImpactItem[] = [];
  const notes: string[] = [];
  for (const line of legacyItems(legacySection(text, 'impact') ?? '').filter((item) => item !== 'none')) {
    const [capability, file, status, ...extra] = line.split('|').map((part) => part.trim());
    const base = status?.split(' ')[0] ?? '';
    if (!capability || !file || extra.length > 0 || !IMPACT_STATUSES.some((known) => known === base)) {
      notes.push(`ignored impact line: ${line}`);
    } else {
      found.push({ capability, file, status });
    }
  }
  return { items: found, notes };
}
