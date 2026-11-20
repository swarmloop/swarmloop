import type { ReviewResult } from '../../agent-result/definitions/review';
import type { Requirement } from '../../contract/requirement-list';

/**
 * The server's check of the requirements reviewer's answer against the run's Requirements list. `itemIds` are the
 * contract items of a split parent: the review marks each of them like a requirement.
 */
export function requirementsCheck(
  list: readonly Requirement[],
  itemIds: readonly string[] = [],
): (value: unknown) => string[] {
  const ids = [...list.map((requirement) => requirement.id), ...itemIds];
  const known = new Set(ids);
  const listName = (id: string): string => (itemIds.includes(id) ? 'contract items' : 'Requirements list');
  return (value) => {
    const { decision, requirements = [] } = value as ReviewResult;
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const mark of requirements) {
      if (!known.has(mark.id)) {
        problems.push(
          `${mark.id} is not an id of the Requirements list${itemIds.length > 0 ? ' or of the contract items' : ''}`,
        );
      } else if (seen.has(mark.id)) {
        problems.push(`${mark.id} has more than one entry in requirements`);
      }
      seen.add(mark.id);
    }
    for (const id of ids.filter((item) => !seen.has(item))) {
      problems.push(`${id} has no entry in requirements: give one entry for each id of the ${listName(id)}`);
    }
    const unmet = requirements.filter((mark) => mark.status !== 'met').map((mark) => mark.id);
    if (decision === 'ok' && unmet.length > 0) {
      problems.push(
        `decision is ok but ${unmet.join(', ')} is not met: any partial or missing requirement is a return`,
      );
    }
    return problems;
  };
}
