import { Injectable } from '@nestjs/common';
import { existsSync } from 'fs';
import type { GitChange } from '../../agent-result/definitions/git-change';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git } from '../../git/git';
import { readGitFormat, type GitFormat } from '../../git/naming/git-format';
import { branchName, commitMessage, mergeRequestTitle, summaryForBranch } from '../../git/naming/git-names';
import { formatBranchNames, parseBranchNames, storedBranch } from '../../git/naming/stored-branch';
import { worktreePath } from '../../git/repo-names';
import type { RunEntity } from '../../history/run.entity';
import { root } from '../../history/run-paths';
import { ARTIFACTS } from '../contract/artifacts';
import type { Artifact } from '../contract/artifact';
import { StepKernel } from '../step-kernel';

type Run = Pick<RunEntity, 'key' | 'parentRunId' | 'taskId'>;
type StoredResult = Pick<Artifact<unknown>, 'kind' | 'parse'>;

/** What a stored implement or plan result may say of the change: its own, and a split plan's per task. */
interface ChangeResult {
  change?: GitChange;
  tasks?: { id: string; change?: GitChange }[];
}

/** The one place that knows which name a run's branch, commits and merge request carry. */
@Injectable()
export class RunNames {
  constructor(private readonly kernel: StepKernel) {}

  /** The stored branch of a repository, or today's name for a run that stored none. Null reads the run's first line. */
  async branch(run: Run, repo: string | null): Promise<string> {
    const stored = await this.kernel.documents.latestBody(run.key, ARTIFACTS.branchNames.kind);
    const requirements = await this.kernel.documents.latestBody(run.key, ARTIFACTS.requirements.kind);
    if (!requirements && parseBranchNames(stored).size === 0) {
      throw new SwarmloopError('requirements is missing');
    }
    return storedBranch(stored, repo, run.key, requirements ? summaryForBranch(requirements, run.key) : '');
  }

  /**
   * Stores the branch of each repository that has none, and returns every line. A repository keeps the name it has;
   * a worktree already on today's name keeps it; every repository of a run shares one name, from the first repository's format, because the steps that push
   * and merge take one branch for all trees.
   */
  async store(run: RunEntity, repos: string[]): Promise<Map<string, string>> {
    const lines = parseBranchNames(await this.kernel.documents.latestBody(run.key, ARTIFACTS.branchNames.kind));
    const missing = repos.filter((repo) => !lines.has(repo));
    if (missing.length === 0) {
      return lines;
    }
    const summary = await this.summary(run);
    const change = (await this.change(run)).change;
    let shared = [...lines.values()][0] ?? null;
    for (const repo of missing) {
      shared ??= await this.fresh(run, repo, summary, change);
      lines.set(repo, shared);
    }
    await this.kernel.documents.putDocument(run, ARTIFACTS.branchNames.kind, formatBranchNames(lines));
    return lines;
  }

  /** The commit message; a commit on a branch already pushed follows a return, and is a fix unless implement named a type. */
  async commitMessage(run: Run, repo: string): Promise<string> {
    const { change, implemented } = await this.change(run);
    const summary = await this.summary(run);
    const pushed = (await this.kernel.documents.latestBody(run.key, ARTIFACTS.pipelineRef.kind)) !== null;
    const followed = pushed && !implemented ? { ...(change ?? { subject: summary }), type: 'fix' as const } : change;
    return commitMessage(run.key, summary, { template: this.format(run, repo).commit, change: followed });
  }

  async title(run: Run, repo: string): Promise<string> {
    const { change } = await this.change(run);
    return mergeRequestTitle(run.key, await this.summary(run), {
      template: this.format(run, repo).title,
      change,
    });
  }

  /** The title of a task that merges into the feature branch, or null when the repository has no title format. */
  async taskTitle(run: Run, repo: string, task: string): Promise<string | null> {
    const template = this.format(run, repo).title;
    return template === null
      ? null
      : mergeRequestTitle(run.key, await this.summary(run), {
          template,
          task,
          change: (await this.change(run)).change,
        });
  }

  /** The branch merge requests aim at, when the repository names one. */
  target(run: Run, repo: string): string | null {
    return this.format(run, repo).target;
  }

  private format(run: Run, repo: string): GitFormat {
    return readGitFormat(worktreePath(root(this.kernel.config), run.key, repo));
  }

  private async summary(run: Run): Promise<string> {
    const requirements = await this.kernel.documents.latestBody(run.key, ARTIFACTS.requirements.kind);
    if (!requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    return summaryForBranch(requirements, run.key);
  }

  private async fresh(run: Run, repo: string, summary: string, change: GitChange | undefined): Promise<string> {
    const today = branchName(run.key, summary);
    const tree = worktreePath(root(this.kernel.config), run.key, repo);
    if (existsSync(tree) && (await git(['-C', tree, 'branch', '--show-current'])) === today) {
      return today;
    }
    return branchName(run.key, summary, { template: readGitFormat(tree).branch, change });
  }

  /** The meaning of the run's change: implement's own, else the plan's, else the one the parent's plan gave this task. */
  private async change(run: Run): Promise<{ change: GitChange | undefined; implemented: boolean }> {
    const implemented = await this.latestResult(run.key, [
      ARTIFACTS.implementationResult,
      ARTIFACTS.implementationImproveResult,
    ]);
    if (implemented?.change) {
      return { change: implemented.change, implemented: true };
    }
    const planned = await this.latestResult(run.key, [ARTIFACTS.planResult, ARTIFACTS.planImproveResult]);
    return { change: planned?.change ?? (await this.taskChange(run)), implemented: false };
  }

  private async taskChange(run: Run): Promise<GitChange | undefined> {
    const parent = run.parentRunId === null ? null : await this.kernel.runs.findById(run.parentRunId);
    if (!parent) {
      return undefined;
    }
    const plan = await this.latestResult(parent.key, [ARTIFACTS.planResult, ARTIFACTS.planImproveResult]);
    return plan?.tasks?.find((task) => task.id === run.taskId)?.change;
  }

  /** The newest stored result among the kinds, or null. A result that no longer reads is none. */
  private async latestResult(key: string, kinds: StoredResult[]): Promise<ChangeResult | null> {
    let newest: { id: number; body: string; kind: StoredResult } | null = null;
    for (const kind of kinds) {
      const found = await this.kernel.documents.latestDocument(key, kind.kind);
      if (found && (!newest || found.id > newest.id)) {
        newest = { ...found, kind };
      }
    }
    try {
      return newest ? (newest.kind.parse(newest.body) as ChangeResult) : null;
    } catch {
      return null;
    }
  }
}
