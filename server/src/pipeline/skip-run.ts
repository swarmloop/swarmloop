import { REASON } from '../contract/run-state';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';

/**
 * Stops the run of a skipped task and closes it for good with `reason`. `blocked` keeps a restart from relaunching it.
 * Null when the run already reads `skipped`; otherwise the run as written.
 */
export async function skipRun(
  runs: RunRepository,
  stop: (run: RunEntity) => Promise<void>,
  child: RunEntity,
  reason: string,
): Promise<RunEntity | null> {
  if (storedState(child).state === 'skipped') return null;
  await stop(child);
  return runs.change(child.key, (stopped) => {
    writeRunState(stopped, { status: 'blocked', reason: { code: REASON.skipped, message: reason } });
    stopped.stepStartedAt = null;
  });
}
