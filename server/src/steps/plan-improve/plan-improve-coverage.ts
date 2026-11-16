import type { CoveredRequirement, Requirement } from '../../contract/requirement-list';
import type { PlanImproveResult } from '../../agent-result/definitions/plan-improve';
import { coverageUnits } from '../plan/plan-coverage';
import { isSplit } from '../plan/plan-tasks';
import { mergeRequirements, type CoverageUnit } from '../shared/requirement-coverage';

/** The stored list with the answer's added and corrected requirements. */
export function mergedList(list: Requirement[], value: Pick<PlanImproveResult, 'requirements'>): Requirement[] {
  return mergeRequirements(list, value.requirements ?? []).list;
}

/** The plan items of a stored coverage, each with the ids it covers, in the order the items first appear. */
function storedUnits(coverage: readonly CoveredRequirement[]): CoverageUnit[] {
  const covers = new Map<string, string[]>();
  for (const requirement of coverage) {
    for (const item of requirement.items) {
      covers.set(item, [...(covers.get(item) ?? []), requirement.id]);
    }
  }
  return [...covers].map(([item, ids]) => ({ item, covers: ids }));
}

/** The units of an answer: its own plan or tasks, or the stored coverage when the answer keeps the plan. */
export function improveUnits(value: PlanImproveResult, stored: readonly CoveredRequirement[]): CoverageUnit[] {
  const keeps = value.plan.length === 0 && !isSplit(value);
  return keeps ? storedUnits(stored) : coverageUnits(value);
}
