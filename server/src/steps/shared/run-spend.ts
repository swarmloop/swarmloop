import type { AgentCallRepository } from '../../history/agent-call.repository';
import type { RunEntity } from '../../history/entities';

/** The cost of each of these runs, read together from the log, as the lookup `epicTotal` takes. */
export async function spendLookup(
  runs: RunEntity[],
  calls: Pick<AgentCallRepository, 'spendOfRuns'>,
): Promise<(run: RunEntity) => number> {
  const sums = await calls.spendOfRuns(runs.map((run) => run.key));
  return (run) => sums.get(run.key) ?? 0;
}
