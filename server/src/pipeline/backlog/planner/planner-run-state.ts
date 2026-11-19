import { deriveState } from '../../../history/run-state';
import type { RunRepository } from '../../../history/run.repository';

/** Why a run is not going on, as its state says it, or an empty text when it has no reason (or no run). */
export async function stopReason(runs: Pick<RunRepository, 'findRun'>, key: string): Promise<string> {
  const run = await runs.findRun(key);
  return run === null ? '' : (deriveState(run).reason?.code ?? '');
}
