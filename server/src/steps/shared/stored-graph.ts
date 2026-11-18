import { ARTIFACTS } from '../contract/artifacts';
import type { ModelStepContext } from '../model-step-context';
import type { StoredGraph } from '../plan/plan-tasks';

/** The tasks, contract and kept capabilities the run stores now. A run that never split has no tasks. */
export async function storedGraph(ctx: Pick<ModelStepContext, 'reread'>): Promise<StoredGraph> {
  return {
    tasks: (await ctx.reread(ARTIFACTS.subtasks)) ?? [],
    contract: (await ctx.reread(ARTIFACTS.contract)) ?? '',
    keep: (await ctx.reread(ARTIFACTS.keep)) ?? [],
  };
}
