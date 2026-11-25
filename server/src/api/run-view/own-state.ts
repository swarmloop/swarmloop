import type { RunEntity } from '../../history/entities';
import type { CommandRepository } from '../../history/command.repository';
import type { RunSummary } from '../../contract/api';
import { liveState } from '../../history/run-state';

export type OwnState = Pick<RunSummary, 'state' | 'stateReason'>;

/** What the state of a run is read from: the pending commands. */
export interface StateSources {
  commands: Pick<CommandRepository, 'queuedRunIds'>;
}

/** The run as the run page shows it: a run the pipeline holds that is not done reads as running. */
export function shownRun(run: RunEntity, claimed: (key: string) => boolean): RunEntity {
  return claimed(run.key) && run.status !== 'done'
    ? { ...run, status: 'running', state: 'running', stateReason: run.state === 'running' ? run.stateReason : null }
    : run;
}

/** The state of each of the runs as the run page shows it, by run key. The list and the tasks of a run page read it the same way. */
export async function ownStates(
  { commands }: StateSources,
  runs: RunEntity[],
  claimed: (key: string) => boolean,
): Promise<Map<string, OwnState>> {
  const queued = await commands.queuedRunIds(runs.map((run) => run.id));
  const states = new Map<string, OwnState>();
  for (const run of runs) {
    const { state, reason } = liveState(shownRun(run, claimed), { queued: queued.has(run.id) });
    states.set(run.key, { state, stateReason: reason });
  }
  return states;
}
