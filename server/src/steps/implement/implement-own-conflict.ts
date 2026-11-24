import { existsSync } from 'fs';
import { root } from '../../history/run-paths';
import { SwarmloopError } from '../../core/swarmloop-error';
import { originRef } from '../../git/base-ref';
import { commitIdentity, git, gitDetail, type CommitAuthor } from '../../git/git';
import { unmergedPaths } from '../../git/rebase';
import { resolveGitPath } from '../../git/rebase/hidden-worktree';
import { mountsForStep, worktreePath } from '../../git/repo-names';
import { withWorktree } from '../../git/worktree-lock';
import { rebaseResolution, type RebaseResolutionResult } from '../../agent-result/definitions/rebase-resolution';
import { agentWorkplace, projectFor } from '../shared/agent-environment';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../agent-step';
import { ownConflictPrompt } from './implement.prompts';
import type { PlanChatEntry } from '../../contract/plan-chat';
import { askConflict, resolvedResult, type RebaseDeps } from './rebase-resolved';
import { takeAnswer } from './implement-question';

/** True while git holds a rebase in the worktree: it stopped at a conflict and waits for the files. */
function rebasing(cwd: string): Promise<boolean> {
  return withWorktree(cwd, async () => {
    const path = await resolveGitPath(cwd, 'rebase-merge');
    return path !== null && existsSync(path);
  });
}

/** True when the head of the worktree holds the feature branch from origin and goes beyond it. */
function ahead(cwd: string, remote: string): Promise<boolean> {
  return withWorktree(cwd, async () => {
    const holds = await git(['-C', cwd, 'merge-base', '--is-ancestor', remote, 'HEAD']).then(
      () => true,
      () => false,
    );
    return holds && (await git(['-C', cwd, 'rev-parse', 'HEAD'])) !== (await git(['-C', cwd, 'rev-parse', remote]));
  });
}

/**
 * The pass of a split parent parked the conflict between its own edits and the feature branch as a rebase that
 * stopped. The agent resolves the files, the server continues the rebase until it ends and pushes the result, which
 * only adds commits to the feature branch. A visit that a crash cut short finds no rebase and only pushes.
 */
export async function settleOwnConflict(
  deps: RebaseDeps,
  requirements: string,
  ctx: ModelStepContext,
  names: string[],
  branch: string,
  conflict: string,
  answer: PlanChatEntry | null = null,
): Promise<StepResult> {
  const { run } = ctx.opened;
  const mounts = mountsForStep(root(deps.config), run.key, names, run.targetPath);
  const place = { run, key: run.key, step: deps.step, mounts, runtime: deps.runtime, samples: ctx.samples };
  const sent = new Set<string>();
  let carried = answer;
  for (const repo of names) {
    const cwd = worktreePath(root(deps.config), run.key, repo);
    while (await rebasing(cwd)) {
      const files = await withWorktree(cwd, () => unmergedPaths(cwd));
      const id = `${repo}\0${files.slice().sort().join('\0')}`;
      if (files.length === 0 || sent.has(id)) {
        return askConflict(deps, ctx, { kind: 'conflict', repo, files, stderr: '', base: '', commit: '' });
      }
      sent.add(id);
      const workplace = await agentWorkplace(
        deps.environments,
        place,
        `${ownConflictPrompt({ repo, files, conflict, requirements, handoff: await ctx.reread(ARTIFACTS.handoff), answer: carried })}\n`,
      );
      const resolved = await ctx.launch({
        ...workplace,
        projectFor: projectFor(deps.environments, place),
        mounts,
        resume: false,
        result: rebaseResolution,
      });
      await takeAnswer(deps.chat, run.key, carried);
      carried = null;
      await ctx.write(ARTIFACTS.rebaseResolutionResult, resolved.resultValue as RebaseResolutionResult);
      await continueRebase(cwd, repo, await deps.author.of(run));
    }
  }
  const leases: { repo: string; tip: string | null }[] = [];
  for (const tree of deps.publisher.trees(run.key, names)) {
    if (!(await ahead(tree.path, originRef(branch)))) continue;
    leases.push({ repo: tree.repo, tip: await deps.publisher.optionalRev(tree, `refs/remotes/${originRef(branch)}`) });
  }
  await deps.publisher.publishRebased(run.key, branch, leases);
  return resolvedResult(
    deps,
    ctx,
    mounts,
    "- resolved the conflict of the parent's own edits with the feature branch\n",
  );
}

/** Stages what the agent resolved and takes the rebase on. A stop at the next commit leaves the rebase open for the loop. */
function continueRebase(cwd: string, repo: string, author: CommitAuthor | null): Promise<void> {
  return withWorktree(cwd, async () => {
    const still = await unmergedPaths(cwd);
    try {
      if (still.length > 0) await git(['-C', cwd, 'add', '--', ...still]);
      const identity = await commitIdentity(cwd, author);
      await git(['-C', cwd, ...identity.args, '-c', 'core.editor=true', 'rebase', '--continue'], identity.env);
    } catch (error) {
      if (!(await rebasing(cwd))) throw new SwarmloopError(`${repo} rebase failed: ${gitDetail(error)}`);
    }
  });
}
