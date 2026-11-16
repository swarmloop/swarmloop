import type { ReviewResult } from '../../agent-result/definitions/review';
import type { Requirement } from '../../contract/requirement-list';

/** The server's check of the requirements reviewer's answer against the run's Requirements list. */
export function requirementsCheck(list: readonly Requirement[]): (value: unknown) => string[] {
  const known = new Set(list.map((requirement) => requirement.id));
  return (value) => {
    const { decision, requirements = [] } = value as ReviewResult;
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const mark of requirements) {
      if (!known.has(mark.id)) {
        problems.push(`${mark.id} is not an id of the Requirements list`);
      } else if (seen.has(mark.id)) {
        problems.push(`${mark.id} has more than one entry in requirements`);
      }
      seen.add(mark.id);
    }
    for (const requirement of list.filter((item) => !seen.has(item.id))) {
      problems.push(
        `${requirement.id} has no entry in requirements: give one entry for each id of the Requirements list`,
      );
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
