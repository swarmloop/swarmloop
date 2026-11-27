import { REASON } from '../contract/run-state';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { closeEpicQuestions, closeSkippedQuestions, type SkippedQuestionDeps } from './skipped-questions';

/**
 * Stops the run of a skipped task, closes its open questions with `reason`, its epic's copy of them included, and ends
 * it for good. `blocked` keeps a restart from relaunching it. A run that already reads `skipped` only has its questions
 * closed, with the reason stored with its skip, so a retry finishes the close in the skip's own words. Null when the
 * run already read `skipped`; otherwise the run as written.
 */
export async function skipRun(
  deps: SkippedQuestionDeps & { runs: RunRepository },
  stop: (run: RunEntity) => Promise<void>,
  child: RunEntity,
  reason: string,
): Promise<RunEntity | null> {
  const stored = storedState(child);
  if (stored.state === 'skipped') {
    const kept = stored.reason?.message ?? reason;
    await closeSkippedQuestions(deps, child, kept);
    await closeEpicQuestions(deps, child, kept);
    return null;
  }
  await stop(child);
  await closeSkippedQuestions(deps, child, reason);
  await closeEpicQuestions(deps, child, reason);
  return deps.runs.change(child.key, (stopped) => {
    writeRunState(stopped, { status: 'blocked', reason: { code: REASON.skipped, message: reason } });
    stopped.stepStartedAt = null;
  });
}
