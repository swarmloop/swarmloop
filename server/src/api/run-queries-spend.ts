import type { AgentCallRepository } from '../history/agent-call.repository';
import type { RunEntity } from '../history/entities';

/** What a run has cost and used in tokens: the sums of its rows in the log. */
export async function loggedUsage(
  run: RunEntity,
  calls: Pick<AgentCallRepository, 'spendOfRun' | 'tokensOfRun'>,
): Promise<{ usd: number; tokens: number }> {
  const [usd, tokens] = await Promise.all([calls.spendOfRun(run.key), calls.tokensOfRun(run.key)]);
  return { usd, tokens };
}
