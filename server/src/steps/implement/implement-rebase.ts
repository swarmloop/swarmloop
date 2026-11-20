import { root } from '../../history/run-paths';
import { SwarmloopError } from '../../core/swarmloop-error';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../agent-step';
import { git, gitDetail } from '../../git/git';
import { type RebaseStop, completeRebase, parkedConflict, rebaseFeatureRepos, unmergedPaths } from '../../git/rebase';
import { forRepo, type PerRepo } from '../../git/per-repo';
import { mountsForStep, worktreePath } from '../../git/repo-names';
import { agentWorkplace, projectFor } from '../shared/agent-environment';
import { runJournal } from '../shared/rebase-journal';
import { rebaseResolution, type RebaseResolutionResult } from '../../agent-result/definitions/rebase-resolution';
import { failConflict, resolvedResult, type RebaseDeps } from './rebase-resolved';
import { settleOwnConflict } from './implement-own-conflict';
import { ownConflictOf } from './own-conflict-marker';
import { rebaseConflictPrompt } from './implement.prompts';

/** Finish an open rebase in the server. A stored checklist then goes to code review; an unfinished one returns to the checklist prompt. */
export async function settleRebase(
  deps: RebaseDeps,
  requirements: string,
  ctx: ModelStepContext,
  marker: string,
  names: string[],
  branch: PerRepo<string>,
  storedStderr: string,
): Promise<StepResult | null> {
  const { key } = ctx.opened.run;
  if (marker !== 'pending' && marker !== 'pending-implement') {
    return null;
  }
  const own = ownConflictOf(storedStderr);
  if (marker === 'pending' && own !== null) {
    return settleOwnConflict(deps, requirements, ctx, names, forRepo(branch, names[0] ?? ''), own);
  }
  const bases = new Map<string, string>();
  const input = {
    root: root(deps.config),
    key,
    repos: names,
    branch,
    prompt: ctx.opened.run.prompt,
    denied: [],
    message: await deps.names.commitMessageOf(ctx.opened.run, names),
    author: await deps.author.of(ctx.opened.run),
    hosts: await deps.publisher.hostsFor(ctx.opened.run),
    journal: runJournal(deps.documents, ctx.opened.run),
    onBase: (repo: string, sha: string) => {
      bases.set(repo, sha);
    },
  };
  const mounts = mountsForStep(root(deps.config), key, names, ctx.opened.run.targetPath);
  let outcome: RebaseStop | null = null;
  for (const repo of names) {
    const parked = await parkedConflict(worktreePath(root(deps.config), key, repo), repo, ctx.opened.run.prompt);
    if (parked) {
      outcome = parked;
      break;
    }
  }
  if (!outcome) {
    outcome = await rebaseFeatureRepos(input);
  }
  const seen = new Set<string>();
  while (outcome.kind === 'conflict') {
    if (!outcome.stderr.trim() && storedStderr) {
      outcome = { ...outcome, stderr: storedStderr };
    }
    const id = `${outcome.repo}\0${outcome.files.slice().sort().join('\0')}`;
    if (seen.has(id)) {
      return failConflict(deps, ctx, outcome);
    }
    seen.add(id);
    const place = {
      run: ctx.opened.run,
      key,
      step: deps.step,
      mounts,
      runtime: deps.runtime,
      samples: ctx.samples,
    };
    const workplace = await agentWorkplace(
      deps.environments,
      place,
      `${rebaseConflictPrompt({
        repo: outcome.repo,
        files: outcome.files,
        requirements,
        base: outcome.base,
        commit: outcome.commit,
      })}\n`,
    );
    const resolved = await ctx.launch({
      ...workplace,
      projectFor: projectFor(deps.environments, place),
      mounts,
      resume: false,
      result: rebaseResolution,
    });
    await ctx.write(ARTIFACTS.rebaseResolutionResult, resolved.resultValue as RebaseResolutionResult);
    const cwd = worktreePath(root(deps.config), key, outcome.repo);
    const still = await unmergedPaths(cwd);
    if (still.length > 0) {
      try {
        await git(['-C', cwd, 'add', '--', ...still]);
      } catch (error) {
        throw new SwarmloopError(`${outcome.repo} rebase failed: ${gitDetail(error)}`);
      }
    }
    outcome = await rebaseFeatureRepos(input);
  }
  await deps.environments.refreshAfterRebase(ctx.opened.run, mounts, bases);
  await completeRebase(input.journal);
  if (marker === 'pending-implement') {
    await ctx.write(ARTIFACTS.rebaseConflict, 'review\n');
    return null;
  }
  await deps.publisher.publishRebased(key, branch, outcome.leases);
  return resolvedResult(deps, ctx, mounts, '- resolved the rebase\n');
}
