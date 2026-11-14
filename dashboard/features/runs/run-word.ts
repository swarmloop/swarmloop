import type { RunSummary } from '@contract/api';
import { stateWord } from '@contract/run-state';
import type { StateWord } from '@contract/run-state';
import { when } from '../../lib/format';

/** The state word of a listed run, the same one the run page shows. */
export function runWord(run: RunSummary): StateWord {
  return stateWord(
    run.state,
    run.stateReason,
    { subtask: Boolean(run.parentKey), merge: run.merge, mergeWait: run.mergeWait },
    when,
  );
}
