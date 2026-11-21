import { useMemo } from 'react';
import { useLiveBridge } from '../shell';

/** The stamp the statistics reload on: it moves when a run appears, goes, changes status or changes part, not on every live tick. */
export function useStatsVersion(): string {
  const runs = useLiveBridge((snapshot) => snapshot.runs);
  // The same counts as the run list's switch, so a subtask is never counted on its own.
  const { active, done, all } = useLiveBridge((snapshot) => snapshot.counts);
  const stamp = useLiveBridge((snapshot) => snapshot.statusStamp);
  return useMemo(
    () => `${runs.map((run) => `${run.key}:${run.status}`).join(',')}|${active}/${done}/${all}|${stamp}`,
    [runs, active, done, all, stamp],
  );
}
