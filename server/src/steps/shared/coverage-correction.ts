import type { Requirement } from '../../contract/requirement-list';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { ResultDefinition } from '../../agent-result/result-definition';
import { resultFollowUp } from '../../agent-result/result-follow-up';
import type { ModelStepContext } from '../model-step-context';
import { coverageProblems, type CoverageUnit } from './requirement-coverage';

/** What a coverage correction asks of the step: the definition it asked for, its check, and how its result reads. */
interface CoverageRequest<T> {
  mounts: SandboxMount[];
  result: ResultDefinition;
  check: (value: unknown) => string[];
  continuePrompt?: string;
  /** Reads the validated object of a launch into the step's own result. */
  read: (value: unknown) => T;
  /** The run's requirement list as this result leaves it. */
  listOf: (value: T) => Requirement[];
  /** The plan items or tasks of this result with the requirement ids they cover. */
  unitsOf: (value: T) => CoverageUnit[];
}

interface CheckedCoverage<T> {
  value: T;
  list: Requirement[];
  units: CoverageUnit[];
  /** What is still wrong after the one correction; coverage never fails the step. */
  problems: string[];
}

/**
 * Checks a result against the run's requirements. A gap goes back once in the same chat with the same check; the
 * result of that launch is taken, and what it still leaves open is returned for the step to write down.
 */
export async function correctCoverage<T>(
  ctx: ModelStepContext,
  request: CoverageRequest<T>,
  first: T,
): Promise<CheckedCoverage<T>> {
  const checked = (value: T): CheckedCoverage<T> => {
    const list = request.listOf(value);
    const units = request.unitsOf(value);
    return { value, list, units, problems: coverageProblems(list, units) };
  };
  const before = checked(first);
  if (before.problems.length === 0) {
    return before;
  }
  const again = await ctx.launch({
    prompt: resultFollowUp(before.problems),
    mounts: request.mounts,
    continuePrompt: request.continuePrompt,
    result: request.result,
    check: request.check,
  });
  return again.resultValue === undefined ? before : checked(request.read(again.resultValue));
}

/** The prompt section that holds the numbered requirements, one `id: text` line each. */
export function requirementsSection(list: readonly Requirement[]): { heading: string; body: string } {
  return {
    heading: 'Requirements list',
    body: list.map((requirement) => `${requirement.id}: ${requirement.text}`).join('\n'),
  };
}

/** The lines a step writes for the gaps its one correction left. */
export function gapLines(problems: readonly string[]): string[] {
  return problems.map((problem) => `coverage gap: ${problem}`);
}
