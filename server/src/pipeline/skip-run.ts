import { REASON } from '../contract/run-state';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { closeSkippedQuestions, type SkippedQuestionDeps } from './skipped-questions';

/**
 * Stops the run of a skipped task, closes its open questions with `reason`, and ends it for good. `blocked` keeps a
 * restart from relaunching it. A run that already reads `skipped` only has its questions closed, so a retry finishes
 * the close. Null when the run already read `skipped`; otherwise the run as written.
 */
export async function skipRun(
  deps: SkippedQuestionDeps & { runs: RunRepository },
  stop: (run: RunEntity) => Promise<void>,
  child: RunEntity,
  reason: string,
): Promise<RunEntity | null> {
  if (storedState(child).state === 'skipped') {
    await closeSkippedQuestions(deps, child, reason);
    return null;
  }
  await stop(child);
  await closeSkippedQuestions(deps, child, reason);
  return deps.runs.change(child.key, (stopped) => {
    writeRunState(stopped, { status: 'blocked', reason: { code: REASON.skipped, message: reason } });
    stopped.stepStartedAt = null;
  });
}
