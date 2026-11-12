import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { CheckoutRepository } from '../../history/checkout.repository';
import { root } from '../../history/run-paths';
import type { AppConfig } from '../../config/env';
import { SwarmloopError } from '../../core/swarmloop-error';
import { commitMessage, summaryForBranch } from '../branch/branch-name';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../agent-step';
import { git, gitDetail } from '../../git/git';
import { type RebaseStop, completeRebase, parkedConflict, rebaseFeatureRepos, unmergedPaths } from '../../git/rebase';
import { worktreeStatus } from '../../git/worktree-git';
import { mountsForStep, worktreePath } from '../../git/repo-names';
import type { EnvironmentService } from '../../environment/environment.service';
import { agentWorkplace, projectFor } from '../shared/agent-environment';
import { textDocument } from '../shared/handoff';
import { runJournal } from '../shared/rebase-journal';
import type { RebasedPublisher } from '../shared/rebased-publisher';
import { rebaseConflictPrompt } from './implement.prompts';

/** What finishing an open rebase needs from the implement step. */
export interface RebaseDeps {
  config: AppConfig;
  documents: DocumentRepository;
  flows: FlowRepository;
  checkouts: CheckoutRepository;
  publisher: RebasedPublisher;
  environments: EnvironmentService;
  step: string;
  runtime: RuntimeName;
}

/** Finish an open rebase in the server. A stored checklist then goes to code review; an unfinished one returns to the checklist prompt. */
export async function settleRebase(
  deps: RebaseDeps,
  requirements: string,
  ctx: ModelStepContext,
  marker: string,
  names: string[],
  branch: string,
  storedStderr: string,
): Promise<StepResult | null> {
  const { key } = ctx.opened.run;
  if (marker !== 'pending' && marker !== 'pending-implement') {
    return null;
  }
  const bases = new Map<string, string>();
  const input = {
    root: root(deps.config),
    key,
    repos: names,
    branch,
    prompt: ctx.opened.run.prompt,
    denied: await deps.checkouts.listDenyPaths(),
    message: commitMessage(key, summaryForBranch(requirements, key)),
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
    await ctx.launch({
      ...workplace,
      projectFor: projectFor(deps.environments, place),
      mounts,
      resume: false,
    });
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
  // The rebased code is checked again before it is reviewed, when the run has the checks phase.
  const next = (await deps.flows.activePhases(ctx.opened.run.id)).includes('checks') ? 'checks' : 'code-review';
  await deps.flows.noteFlow(key, next === 'checks' ? ['checks', 'code-review', 'ci'] : ['code-review', 'ci'], next);
  const existing = (await ctx.reread(ARTIFACTS.implementation)) ?? '';
  if (!existing.trim()) {
    throw new SwarmloopError('implementation is missing');
  }
  const body = existing.endsWith('\n') ? existing : `${existing}\n`;
  const status = await worktreeStatus(mounts);
  return {
    route: { to: 'jump', step: next },
    summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
    outputs: [{ artifact: ARTIFACTS.implementation, value: body }],
    handoff: '- resolved the rebase\n',
    visit: {
      documents: [
        textDocument(ARTIFACTS.rebaseConflict.kind, 'review\n'),
        textDocument(ARTIFACTS.rebaseMergeSkip.kind, 'skip\n'),
      ],
    },
  };
}

function failConflict(
  deps: RebaseDeps,
  ctx: ModelStepContext,
  outcome: Extract<RebaseStop, { kind: 'conflict' }>,
): StepResult {
  const detail = [outcome.files.join(', '), outcome.stderr.trim()].filter((part) => part.length > 0).join('\n');
  const line = `${ctx.opened.startedAt} ${outcome.repo} rebase failed: ${detail}`;
  return { route: { to: 'fail', error: { code: deps.step, message: line } }, summary: line, outputs: [] };
}
