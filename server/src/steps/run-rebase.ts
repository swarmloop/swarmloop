import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import type { SandboxMount } from '../core/sandbox-mount';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { root } from '../history/run-paths';
import { RunNames } from './shared/run-names';
import { RunAuthor } from './shared/run-author';
import { completeRebase, rebaseFeatureRepos } from '../git/rebase';
import { sameOwnDiff } from '../git/rebase/own-diff';
import { git } from '../git/git';
import { withWorktrees } from '../git/worktree-lock';
import { isSubtask } from '../contract/subtask';
import { HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import { mountsForStep, repoNames, worktreePath } from '../git/repo-names';
import { ARTIFACTS } from './contract/artifacts';
import { ERROR_CODES } from '../contract/error-codes';
import { storedState, writeRunState } from '../history/run-state';
import { MergeRequestDrafts } from './merge-request/merge-request-draft';
import { runJournal } from './shared/rebase-journal';
import type { RebaseJournal } from '../git/rebase';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { actionsFor } from '../contract/run-state';
import { betweenPasses } from './shared/epic-between-passes';
import { RebasedPublisher } from './shared/rebased-publisher';
import type { RebaseStop } from '../git/rebase/types';
import { forwardOwnLess } from './shared/main-forward';

/** The steps that read a review or a CI result. */
const AFTER_REVIEW: readonly string[] = ['commit', 'merge-request', 'pipeline'];

export abstract class RunRebaseEnvironment {
  abstract refreshAfterRebase(
    run: RunEntity,
    mounts: SandboxMount[],
    bases: ReadonlyMap<string, string>,
  ): Promise<void>;
}

@Injectable()
export class RunRebase {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly flows: FlowRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly environments: RunRebaseEnvironment,
    private readonly drafts: MergeRequestDrafts,
    private readonly registry: CodeHostRegistry,
    private readonly names: RunNames,
    private readonly author: RunAuthor,
    private readonly publisher: RebasedPublisher,
  ) {}

  /**
   * A reconciler resume of an unfinished journal is not a new command: it does not raise the generation. `byParent`
   * is the parent of a subtask moving it onto the feature branch, which a person is never offered for a blocked or
   * working run. A blocked subtask is moved and left blocked (`stay`): only a person's Resume, Replay or Skip moves it on.
   * A subtask blocked by a check goes on instead: the move gave it a new tree, so its checks run once on it.
   * `byMain` is the machine bringing a new green main into an epic that waits between passes; it publishes the
   * rebased branch so the subtasks move onto it, and an epic that conflicts with main is blocked and moves nothing.
   */
  async rebase(key: string, resume = false, byParent = false, byMain = false): Promise<'resume' | 'start' | 'stay'> {
    const run = await this.requireRun(key);
    this.assertOffered(run, byParent, byMain);
    const { state, reason } = storedState(run);
    const stays = byParent && state === 'blocked' && reason?.code !== ERROR_CODES.CHECK_FAILED;
    const status = run.status;
    if (!resume) {
      await this.assertSubtasksIdle(run);
      await this.turnBackToDraft(run);
      await this.runs.bumpGeneration(key);
    }
    const journal = runJournal(this.documents, await this.requireRun(key));
    const bases = new Map<string, string>();
    const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
    const paths = this.worktreePaths(run, names);
    const { heads, stop } = await withWorktrees(paths, async () => {
      const heads = status === 'done' ? await this.heads(run) : new Map<string, string>();
      try {
        const stop = await this.rebaseWorktrees(run, bases, journal, byMain);
        await this.environments.refreshAfterRebase(
          run,
          mountsForStep(root(this.config), run.key, names, run.targetPath),
          bases,
        );
        await completeRebase(journal, run.key);
        return { heads, stop };
      } catch (error) {
        if (error instanceof HostUnavailable) throw error;
        const message = error instanceof SwarmloopError ? error.message : 'rebase failed';
        throw new ConflictException(message);
      }
    });
    if (stop.kind === 'conflict') {
      const unfinished = await this.checklistUnfinished(run);
      await this.documents.putDocument(
        run,
        ARTIFACTS.rebaseConflict.kind,
        unfinished ? 'pending-implement\n' : 'pending\n',
      );
      if (byMain) return this.blockOnMain(run, stop);
      return stays ? 'stay' : this.startAtImplement(run);
    }
    if (byMain) await withWorktrees(paths, async () => this.publishMain(key, run, names, stop.leases));
    if (stays) return 'stay';
    if (await this.checklistUnfinished(run)) {
      return this.startAtImplement(run);
    }
    if (status === 'done') {
      await this.documents.putDocument(await this.requireRun(key), ARTIFACTS.rebaseMergeSkip.kind, 'skip\n');
      const stands = await withWorktrees(paths, () => this.reviewStands(run, heads, bases));
      return stands ? this.startAtChecks(run) : this.startAtReview(key);
    }
    // Every review and CI result of the old generation is stale: a step that reads them goes back through code-review.
    return AFTER_REVIEW.includes(run.currentStep) ? this.startAtReview(key) : 'resume';
  }

  /** A Rebase is for the states `actionsFor` offers it in, and for a blocked or working subtask when its parent sends it. */
  private assertOffered(run: RunEntity, byParent: boolean, byMain: boolean): void {
    const { state, reason } = storedState(run);
    const parentMay = byParent && isSubtask(run) && (state === 'blocked' || state === 'running');
    const mainMay = byMain && run.split && betweenPasses(run);
    if (!parentMay && !mainMay && !actionsFor(state, reason?.code ?? null).includes('rebase')) {
      throw new ConflictException(`${run.key} is ${state}`);
    }
  }

  private async turnBackToDraft(run: RunEntity): Promise<void> {
    try {
      await this.drafts.backToDraft(run);
    } catch (error) {
      if (error instanceof HostUnavailable) throw error;
      throw new ConflictException(error instanceof SwarmloopError ? error.message : 'merge request failed');
    }
  }

  /** The feature branch moves under a subtask that works on it: a Rebase waits until none runs. */
  private async assertSubtasksIdle(run: RunEntity): Promise<void> {
    if (!(await this.subtasksIdle(run))) throw new ConflictException(ERROR_CODES.SUBTASKS_RUNNING);
  }

  /** True when no subtask of the run runs or is held; a run with no subtasks is idle. */
  async subtasksIdle(run: RunEntity): Promise<boolean> {
    if (!run.split) return true;
    const children = await this.runs.children(run);
    return !children.some((child) => child.status === 'running' || this.runs.held(child));
  }

  /** The worktree heads of a run, as `<repo>@<sha>` sorted and joined: the tip the subtasks of an epic move onto. */
  async tipOf(key: string): Promise<string> {
    const run = await this.requireRun(key);
    const names = repoNames((await this.documents.latestBody(key, ARTIFACTS.repos.kind)) ?? '');
    const heads = await withWorktrees(this.worktreePaths(run, names), () => this.heads(run));
    return [...heads]
      .map(([repo, sha]) => `${repo}@${sha}`)
      .sort()
      .join(',');
  }

  /** A main move that rebased clean puts the branch on origin before any subtask moves onto it. */
  private async publishMain(
    key: string,
    run: RunEntity,
    names: string[],
    leases: { repo: string; tip: string | null }[],
  ): Promise<void> {
    await this.publisher.publishRebased(key, await this.names.branchOf(run, names), leases);
  }

  /** An epic that conflicts with main stays on its branch, blocked, until a person replays it. */
  private async blockOnMain(run: RunEntity, stop: Extract<RebaseStop, { kind: 'conflict' }>): Promise<'stay'> {
    const fresh = await this.requireRun(run.key);
    const message = `${stop.repo} conflicts with main in ${stop.files.join(', ')}; the epic stays on its branch until a person replays it`;
    writeRunState(fresh, { status: 'blocked', reason: { code: ERROR_CODES.REBASE_CONFLICT, message } });
    await this.runs.saveRun(fresh);
    return 'stay';
  }

  private worktreePaths(run: RunEntity, names: string[]): string[] {
    return names.map((repo) => worktreePath(root(this.config), run.key, repo));
  }

  /** The head of every worktree of the run, before a rebase moves it. */
  private async heads(run: RunEntity): Promise<Map<string, string>> {
    const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
    const heads = new Map<string, string>();
    for (const repo of names) {
      heads.set(repo, await git(['-C', worktreePath(root(this.config), run.key, repo), 'rev-parse', 'HEAD']));
    }
    return heads;
  }

  /** A review of a branch stands when the rebase left what the branch changes as it was. */
  private async reviewStands(
    run: RunEntity,
    heads: ReadonlyMap<string, string>,
    bases: ReadonlyMap<string, string>,
  ): Promise<boolean> {
    if (!isSubtask(run) || heads.size === 0) return false;
    for (const [repo, before] of heads) {
      const base = bases.get(repo);
      const cwd = worktreePath(root(this.config), run.key, repo);
      if (!base || !(await sameOwnDiff(cwd, before, base).catch(() => false))) return false;
    }
    return true;
  }

  /** The rebase changed nothing in the branch's own diff: its code review stands, so the checks and CI run again. */
  private async startAtChecks(run: RunEntity): Promise<'start'> {
    const checks = (await this.flows.activePhases(run.id)).includes('checks');
    await this.flows.noteFlow(run.key, checks ? ['checks', 'ci'] : ['ci'], checks ? 'checks' : 'commit');
    const next = await this.requireRun(run.key);
    writeRunState(next, { status: 'waiting', currentStep: checks ? 'checks' : 'commit' });
    next.stepStartedAt = null;
    await this.runs.saveRun(next);
    return 'start';
  }

  private async startAtReview(key: string): Promise<'start'> {
    await this.flows.noteFlow(key, ['code-review', 'ci'], 'code-review');
    const next = await this.requireRun(key);
    writeRunState(next, { status: 'waiting', currentStep: 'code-review' });
    next.stepStartedAt = null;
    await this.runs.saveRun(next);
    return 'start';
  }

  private async rebaseWorktrees(
    run: RunEntity,
    bases: Map<string, string>,
    journal: RebaseJournal,
    byMain: boolean,
  ): Promise<RebaseStop> {
    const requirements = await this.documents.latestBody(run.key, ARTIFACTS.requirements.kind);
    if (!requirements?.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
    const hosts = {
      ...this.config.env,
      ...(await this.registry.tokensFor(run.startedBy, run.codeHost)),
      clock: this.clock,
    };
    // A branch with nothing of its own is already in main: it goes forward to main's head, with nothing to squash.
    const forwarded = byMain
      ? await forwardOwnLess({ root: root(this.config), key: run.key, repos: names, prompt: run.prompt, hosts })
      : new Map<string, string>();
    for (const [repo, sha] of forwarded) bases.set(repo, sha);
    const repos = names.filter((repo) => !forwarded.has(repo));
    const stop: RebaseStop =
      repos.length === 0
        ? { kind: 'clean', leases: [] }
        : await rebaseFeatureRepos({
            root: root(this.config),
            key: run.key,
            repos,
            branch: await this.names.branchOf(run, names),
            prompt: run.prompt,
            denied: [],
            message: await this.names.commitMessageOf(run, names),
            author: await this.author.of(run),
            hosts,
            journal,
            onBase: (repo, sha) => {
              bases.set(repo, sha);
            },
          });
    if (stop.kind !== 'clean') return stop;
    return { kind: 'clean', leases: [...stop.leases, ...[...forwarded.keys()].map((repo) => ({ repo, tip: null }))] };
  }

  /** Unfinished when this run is still on implement, or no implementation notes were stored. */
  private async checklistUnfinished(run: RunEntity): Promise<boolean> {
    if (run.currentStep === 'implement') {
      return true;
    }
    const notes = (await this.documents.latestBody(run.key, ARTIFACTS.implementation.kind)) ?? '';
    return notes.trim().length === 0;
  }

  private async startAtImplement(run: RunEntity): Promise<'start'> {
    const phases = await this.flows.activePhases(run.id);
    if (!phases.includes('implementation')) {
      await this.flows.noteFlow(run.key, ['implementation', 'checks', 'code-review', 'ci'], 'implement');
    }
    const fresh = await this.requireRun(run.key);
    writeRunState(fresh, { status: 'waiting', currentStep: 'implement' });
    fresh.stepStartedAt = null;
    await this.runs.saveRun(fresh);
    return 'start';
  }

  private async requireRun(key: string): Promise<RunEntity> {
    const run = await this.runs.findRun(key);
    if (!run) throw new NotFoundException(`${key} is missing`);
    return run;
  }
}
