import type { CoveredRequirement, Requirement } from '../../contract/requirement-list';

/** A plan item or a task, with the requirement ids it covers. */
export interface CoverageUnit {
  item: string;
  covers: readonly string[];
}

/** One line for each requirement no unit covers and for each id a unit names that is no requirement. */
export function coverageProblems(list: readonly Requirement[], units: readonly CoverageUnit[]): string[] {
  const known = new Set(list.map((requirement) => requirement.id));
  const covered = new Set(units.flatMap((unit) => unit.covers));
  const uncovered = list
    .filter((requirement) => !covered.has(requirement.id))
    .map((requirement) => `${requirement.id} is not covered: ${requirement.text}`);
  const unknown = units.flatMap((unit) =>
    unit.covers.filter((id) => !known.has(id)).map((id) => `${id} is not a requirement: ${unit.item}`),
  );
  return [...uncovered, ...unknown];
}

/** Each requirement with the items that cover it, `[]` for an uncovered one. */
export function coverageOf(list: readonly Requirement[], units: readonly CoverageUnit[]): CoveredRequirement[] {
  return list.map((requirement) => ({
    ...requirement,
    items: units.filter((unit) => unit.covers.includes(requirement.id)).map((unit) => unit.item),
  }));
}

interface MergedRequirements {
  list: Requirement[];
  problems: string[];
}

/** `T` when the list holds the task's own `T1`, `R` otherwise. */
function seriesOf(list: readonly Requirement[]): string {
  return list.some((requirement) => requirement.id === 'T1') ? 'T' : 'R';
}

/** The id the list gives its next requirement: one more than its highest number in its series. */
export function nextRequirementId(list: readonly Requirement[]): string {
  const series = seriesOf(list);
  const numbers = list
    .filter((requirement) => requirement.id.startsWith(series))
    .map((requirement) => Number(requirement.id.slice(series.length)));
  return `${series}${Math.max(0, ...numbers) + 1}`;
}

/**
 * Applies changes to a list: an id the list holds gets its text corrected, the next id of the list's series is added,
 * and any other id or an empty text is rejected. An id is never removed or renumbered.
 */
export function mergeRequirements(list: readonly Requirement[], changes: readonly Requirement[]): MergedRequirements {
  const merged = list.map((requirement) => ({ ...requirement }));
  const problems: string[] = [];
  for (const change of changes) {
    const text = change.text.trim();
    const existing = merged.find((requirement) => requirement.id === change.id);
    const next = nextRequirementId(merged);
    if (text === '') {
      problems.push(`${change.id} has no text`);
    } else if (existing) {
      existing.text = text;
    } else if (change.id === next) {
      merged.push({ id: change.id, text });
    } else {
      problems.push(`${change.id} is not the next requirement id, which is ${next}`);
    }
  }
  return { list: merged, problems };
}
