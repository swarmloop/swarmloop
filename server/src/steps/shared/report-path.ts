import type { StepStatEntity } from '../../history/step-stat.entity';
import { ARTIFACTS } from '../contract/artifacts';
import type { Issue } from '../contract/step-contract';
import { CODE_REVIEWERS } from '../../contract/steps';
import { firstLine } from '../contract/artifact';
import { readStored } from './report-stored';

/** One step of how the run got here, in plain words. A return carries its reason, and `fix` when the run went on after it. */
export interface PathStep {
  step: string;
  mark: string;
  returned: boolean;
  reason: string | null;
  fix: string | null;
}

interface StoredDocument {
  stepStatId: number;
  kind: string;
  body: string;
}

const LABELS: Record<string, string> = {
  implement: 'implement',
  checks: 'checks',
  commit: 'commit',
  'code-review': 'review',
  pipeline: 'CI',
};

const IMPLEMENT_STEPS: readonly string[] = ['implement', 'implement-improve'];

/** The step a visit stands for in the path. Null for a step the path does not show. */
function labelOf(step: string): string | null {
  return IMPLEMENT_STEPS.includes(step) ? LABELS.implement : (LABELS[step] ?? null);
}

function markOf(step: string, status: string, returned: boolean): string {
  if (status === 'done') {
    return step === 'pipeline' ? '🟢' : step === 'implement' ? '' : '✅';
  }
  if (returned) {
    return step === 'code-review' ? '↩' : step === 'pipeline' ? '🔴' : '❌';
  }
  return status === 'waiting' ? '⏳' : '❌';
}

/** The reason a visit sent the run back, from the issues it stored: the failed command, or the reviewer and its finding. */
function reasonOf(stat: StepStatEntity, documents: StoredDocument[]): string | null {
  const stored = documents.find((item) => item.stepStatId === stat.id && item.kind === ARTIFACTS.issues.kind);
  const issue: Issue | undefined = stored ? readStored(() => ARTIFACTS.issues.parse(stored.body))?.[0] : undefined;
  if (!issue) {
    return null;
  }
  const failed = issue.failed?.[0]?.command;
  if (failed) {
    return `\`${failed}\``;
  }
  const reviewer = CODE_REVIEWERS.find((name) => name === issue.source);
  return reviewer ? `${reviewer}: ${firstLine(issue.body)}` : issue.title;
}

/** The run's visits from step to step, a return with its reason and `fix` once a later visit of the step went on. */
export function reportPath(stats: StepStatEntity[], documents: StoredDocument[]): PathStep[] {
  const path: PathStep[] = [];
  stats.forEach((stat, index) => {
    const label = labelOf(stat.step);
    if (!label) {
      return;
    }
    const next = stats.slice(index + 1).find((item) => labelOf(item.step) !== null);
    const returned = stat.status === 'waiting' && next !== undefined && labelOf(next.step) === LABELS.implement;
    if (label === LABELS.implement && path.some((item) => item.step === label)) {
      return;
    }
    const later = stats.slice(index + 1).some((item) => item.step === stat.step && item.status === 'done');
    path.push({
      step: label,
      mark: markOf(stat.step, stat.status, returned),
      returned,
      reason: returned ? reasonOf(stat, documents) : null,
      fix: returned && later ? 'fixed' : null,
    });
  });
  return path;
}

/** How many of the path's returns the run went on after, and how many there were. */
export function returnCount(path: PathStep[]): { count: number; fixed: boolean } {
  const returns = path.filter((step) => step.returned);
  return { count: returns.length, fixed: returns.length > 0 && returns.every((step) => step.fix !== null) };
}

/** The Returns cell: how many returns, and whether the run went on after each. */
export function returnsText(returns: { count: number; fixed: boolean }): string {
  if (returns.count === 0 || !returns.fixed) {
    return String(returns.count);
  }
  return `${returns.count}, ${returns.count === 1 ? 'fixed' : returns.count === 2 ? 'both fixed' : 'all fixed'}`;
}
