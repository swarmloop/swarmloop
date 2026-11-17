import type { RunSummary } from '@contract/api';
import { stateWord } from '@contract/run-state';
import type { StateWord } from '@contract/run-state';
import { when } from '../../lib/format';

/** The state word of a run, the same one the list and the run page show. */
export function runWord(
  run: Pick<RunSummary, 'state' | 'stateReason' | 'parentKey' | 'merge' | 'mergeWait'>,
): StateWord {
  return stateWord(
    run.state,
    run.stateReason,
    { subtask: Boolean(run.parentKey), merge: run.merge, mergeWait: run.mergeWait },
    when,
  );
}
