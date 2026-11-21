import type { FlowRepository } from '../../history/flow.repository';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import { withWorktrees } from '../../git/worktree-lock';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import { jumpBackToReview } from '../shared/back-to-review';
import { worktreesFingerprint } from '../shared/gate';

/** The step that would settle: the published SHAs and the code-review gate must be those of this generation and these files. */
export async function staleGates(ctx: StepContext, root: string, phases: readonly string[]): Promise<boolean> {
  const { run } = ctx.opened;
  const lines = await ctx.reread(ARTIFACTS.repos);
  if (!lines || lines.length === 0) {
    return false;
  }
  const names = checkedRepoNames(lines);
  const paths = names.map((name) => worktreePath(root, run.key, name));
  const fingerprint = await withWorktrees(paths, () => worktreesFingerprint(paths));
  if (!(await ctx.gate(ARTIFACTS.pipelineRef, fingerprint))) {
    return true;
  }
  return phases.includes('code-review') && !(await ctx.gate(ARTIFACTS.reviewReport, fingerprint));
}

/** The review or the CI result is from before a Replay or a Rebase, or from other files: review again, then publish. */
export function backToReview(ctx: StepContext, flows: FlowRepository): Promise<StepResult> {
  return jumpBackToReview(ctx, flows, 'pipeline result is stale');
}
