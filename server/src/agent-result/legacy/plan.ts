// remove after runs started before f52 are gone
import { legacyItems, legacySection } from './prose-lines';

/** The bullets of the `plan:` section of an answer. Empty when the section is missing or holds only `none`. */
export function legacyPlanItems(text: string): string[] {
  return legacyItems(legacySection(text, 'plan') ?? '').filter((item) => item !== 'none');
}

/** The checklist of a plan object written inside the `plan:` section, cut between its first `{` and its last `}`. */
export function legacyPlanObjectItems(text: string): string[] | null {
  const block = legacySection(text, 'plan');
  const start = block?.indexOf('{') ?? -1;
  const end = block?.lastIndexOf('}') ?? -1;
  if (block === null || start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(block.slice(start, end + 1)) as { name?: unknown; overview?: unknown; items?: unknown };
    if (typeof parsed.name !== 'string' || typeof parsed.overview !== 'string' || !Array.isArray(parsed.items)) {
      return null;
    }
    const items = parsed.items.filter(
      (item): item is string => typeof item === 'string' && item.trim() !== '' && item.trim() !== 'none',
    );
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}
