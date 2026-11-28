import { root } from '../../history/run-paths';
import { SwarmloopError } from '../../core/swarmloop-error';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../agent-step';
import { git, gitDetail } from '../../git/git';
import { type RebaseStop, completeRebase, parkedConflict, rebaseFeatureRepos, unmergedPaths } from '../../git/rebase';
import { forRepo, type PerRepo } from '../../git/per-repo';
import { withWorktrees } from '../../git/worktree-lock';
import { mountsForStep, worktreePath } from '../../git/repo-names';
import { agentWorkplace, projectFor } from '../shared/agent-environment';
import { runJournal } from '../shared/rebase-journal';
import { rebaseResolution, type RebaseResolutionResult } from '../../agent-result/definitions/rebase-resolution';
import type { PlanChatEntry } from '../../contract/plan-chat';
import { answersConflict, askConflict, inRound, resolvedResult, type RebaseDeps } from './rebase-resolved';
import { continueOwnEdits } from './implement-own-conflict';
import { settleHostConflict } from './implement-host-conflict';
import { hostConflictOf } from '../shared/host-conflict-marker';
import { ownConflictOf } from './own-conflict-marker';
import { ownConflictPrompt, rebaseConflictPrompt } from './implement.prompts';
import { plannerWait, takeAnswer } from './implement-question';

type Conflict = Extract<RebaseStop, { kind: 'conflict' }>;

/** The conflict agent's prompt: the parent's own-edits kind and the base-move kind differ only here and in the continue. */
async function conflictPrompt(
  ctx: ModelStepContext,
  own: string | null,
  outcome: Conflict,
  requirements: string,
  answer: PlanChatEntry | null,
): Promise<string> {
  const { repo, files } = outcome;
  if (own === null) {
    return rebaseConflictPrompt({ repo, files, requirements, base: outcome.base, commit: outcome.commit, answer });
  }
  return ownConflictPrompt({
    repo,
    files,
    conflict: own,
    requirements,
    handoff: await ctx.reread(ARTIFACTS.handoff),
    answer,
  });
}

function resolvedNote(own: string | null): string {
  return own === null
    ? '- resolved the rebase\n'
    : "- resolved the conflict of the parent's own edits with the feature branch\n";
}

/**
 * Finish an open rebase in the server. A stored checklist then goes to code review; an unfinished one returns to the
 * checklist prompt; a run in a round, whose tasks are not settled, has no checklist and goes on like a pending one.
 * The planner's answer reaches the conflict agent's prompt and is taken after that launch.
 */
export async function settleRebase(
  deps: RebaseDeps,
  requirements: string,
  ctx: ModelStepContext,
  marker: string,
  names: string[],
  branch: PerRepo<string>,
  storedStderr: string,
  answer: PlanChatEntry | null = null,
): Promise<StepResult | null> {
  const { key } = ctx.opened.run;
  if (marker !== 'pending' && marker !== 'pending-implement') {
    return null;
  }
  // On every path the conflict agent takes only the answer to the question askConflict asked; any other answer stays pending for the visit that asked it.
  const conflictAnswer = answersConflict(answer, deps.step) ? answer : null;
  // The conflict of a parent's own edits is the same loop; only its prompt and the continue of the parked rebase differ.
  const own = marker === 'pending' ? ownConflictOf(storedStderr) : null;
  const host = hostConflictOf(storedStderr);
  if (marker === 'pending' && host !== null) {
    return settleHostConflict(deps, requirements, ctx, names, host, conflictAnswer);
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
    tips: await deps.tips.known(ctx.opened.run, names),
    onBase: (repo: string, sha: string) => {
      bases.set(repo, sha);
    },
  };
  const mounts = mountsForStep(root(deps.config), key, names, ctx.opened.run.targetPath);
  const paths = names.map((repo) => worktreePath(root(deps.config), key, repo));
  const ownEdits = {
    root: input.root,
    key,
    repos: names,
    branch: forRepo(branch, names[0] ?? ''),
    journal: input.journal,
    publisher: deps.publisher,
    author: input.author,
    onBase: input.onBase,
  };
  let outcome: RebaseStop = await withWorktrees(paths, async () => {
    for (const repo of names) {
      const entry = await input.journal.entry(repo);
      const parked = await parkedConflict(
        worktreePath(root(deps.config), key, repo),
        repo,
        ctx.opened.run.prompt,
        entry,
      );
      if (parked) {
        return parked;
      }
    }
    return own !== null ? continueOwnEdits(ownEdits, null) : rebaseFeatureRepos(input);
  });
  const seen = new Set<string>();
  let launched = false;
  let carried = conflictAnswer;
  while (outcome.kind === 'conflict') {
    if (!outcome.stderr.trim() && storedStderr) {
      outcome = { ...outcome, stderr: storedStderr };
    }
    const id = `${outcome.repo}\0${outcome.files.slice().sort().join('\0')}`;
    if (seen.has(id)) {
      return askConflict(deps, ctx, outcome);
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
      `${await conflictPrompt(ctx, own, outcome, requirements, carried)}\n`,
    );
    launched = true;
    const resolved = await ctx.launch({
      ...workplace,
      projectFor: projectFor(deps.environments, place),
      mounts,
      resume: false,
      result: rebaseResolution,
    });
    await takeAnswer(deps.chat, key, carried);
    carried = null;
    await ctx.write(ARTIFACTS.rebaseResolutionResult, resolved.resultValue as RebaseResolutionResult);
    const cwd = worktreePath(root(deps.config), key, outcome.repo);
    const { repo } = outcome;
    outcome = await withWorktrees(paths, async () => {
      if (own !== null) return continueOwnEdits(ownEdits, repo);
      const still = await unmergedPaths(cwd);
      if (still.length > 0) {
        try {
          await git(['-C', cwd, 'add', '--', ...still]);
        } catch (error) {
          throw new SwarmloopError(`${repo} rebase failed: ${gitDetail(error)}`);
        }
      }
      return rebaseFeatureRepos(input);
    });
  }
  await withWorktrees(paths, async () => {
    await deps.environments.refreshAfterRebase(ctx.opened.run, mounts, bases);
    await deps.tips.recordMoved(ctx.opened.run, input.journal);
    await completeRebase(input.journal, key);
  });
  const waiting = launched ? undefined : (await deps.chat?.pendingQuestions(key))?.find((q) => q.from === deps.step);
  if (waiting) {
    // The move was settled by the rule with no agent: the question the run waited on before it is still its wait.
    await ctx.write(ARTIFACTS.rebaseConflict, 'review\n');
    return plannerWait(ctx.opened.run, { step: deps.step, startedAt: ctx.opened.startedAt, question: waiting.text });
  }
  if (marker === 'pending-implement' && !(await inRound(ctx))) {
    await ctx.write(ARTIFACTS.rebaseConflict, 'review\n');
    return null;
  }
  const { leases } = outcome;
  await withWorktrees(paths, () => deps.publisher.publishRebased(key, branch, leases));
  return resolvedResult(deps, ctx, mounts, resolvedNote(own));
}
