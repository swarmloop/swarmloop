import type { Requirement } from '../../contract/requirement-list';
import { mergeRequirements, nextRequirementId } from './requirement-coverage';

/** The list with each new text added under the next id of its series. Blank texts add nothing; the list only grows. */
export function withAdditions(list: readonly Requirement[], texts: readonly string[]): Requirement[] {
  return texts
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .reduce<Requirement[]>(
      (current, text) => mergeRequirements(current, [{ id: nextRequirementId(current), text }]).list,
      list.map((requirement) => ({ ...requirement })),
    );
}
