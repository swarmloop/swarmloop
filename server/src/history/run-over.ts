import type { RunState } from '../contract/run-state';
import type { RunEntity } from './entities';
import { storedState } from './run-state';

/** A plain run or a part that has ended, so nothing comes back to it. */
const RUN_ENDED: readonly RunState[] = ['merged', 'done', 'failed', 'closed', 'skipped'];

/** An epic's parent still gets answers and a merge look until the epic merges or closes. */
const EPIC_ENDED: readonly RunState[] = ['merged', 'closed', 'skipped'];

/** True when a run is over and gains no more rows; a run that is not over can still run or be resumed. */
export function runOver(run: RunEntity): boolean {
  const { state } = storedState(run);
  if (state === 'stopped') return true;
  const epic = run.parentRunId === null && run.epicAt !== null;
  return (epic ? EPIC_ENDED : RUN_ENDED).includes(state);
}
