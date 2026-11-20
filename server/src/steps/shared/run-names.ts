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
import { parseRefusal } from './git-refusal-answer';

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
   * a worktree already on today's name keeps it; each repository gets the name of its own format, except in a run that
   * splits: its subtasks name one base branch, so every repository shares the name of the first repository's format.
   */
  async store(run: RunEntity, repos: string[], split = false): Promise<Map<string, string>> {
    const lines = parseBranchNames(await this.kernel.documents.latestBody(run.key, ARTIFACTS.branchNames.kind));
    const missing = repos.filter((repo) => !lines.has(repo));
    if (missing.length === 0) {
      return lines;
    }
    const summary = await this.summary(run);
    const change = (await this.change(run)).change;
    let shared = split ? ([...lines.values()][0] ?? null) : null;
    for (const repo of missing) {
      const name = shared ?? (await this.fresh(run, repo, summary, change));
      shared = split ? name : null;
      lines.set(repo, name);
    }
    await this.kernel.documents.putDocument(run, ARTIFACTS.branchNames.kind, formatBranchNames(lines));
    return lines;
  }

  /** The stored branch of each repository, read once, for the steps that work on every tree of the run. */
  async branchOf(run: Run, repos: string[]): Promise<(repo: string) => string> {
    const names = new Map<string, string>();
    for (const repo of repos) {
      names.set(repo, await this.branch(run, repo));
    }
    return (repo) => names.get(repo) ?? '';
  }

  /** The commit message of each repository, rendered from its own format. */
  async commitMessageOf(run: Run, repos: string[]): Promise<(repo: string) => string> {
    const messages = new Map<string, string>();
    for (const repo of repos) {
      messages.set(repo, await this.commitMessage(run, repo));
    }
    return (repo) => messages.get(repo) ?? '';
  }

  /** Makes `name` the stored branch of the repository, and of every repository that shared its old name. */
  async rename(run: RunEntity, repo: string, name: string): Promise<void> {
    const lines = parseBranchNames(await this.kernel.documents.latestBody(run.key, ARTIFACTS.branchNames.kind));
    const old = lines.get(repo);
    for (const [other, branch] of lines) {
      if (other === repo || branch === old) {
        lines.set(other, name);
      }
    }
    await this.kernel.documents.putDocument(run, ARTIFACTS.branchNames.kind, formatBranchNames(lines));
  }

  /** The repositories that carry the same stored branch as `repo`, itself included. */
  async sharing(run: Run, repo: string): Promise<string[]> {
    const lines = parseBranchNames(await this.kernel.documents.latestBody(run.key, ARTIFACTS.branchNames.kind));
    const name = lines.get(repo);
    return [...lines]
      .filter(([other, branch]) => other === repo || (name !== undefined && branch === name))
      .map(([other]) => other);
  }

  /** Every distinct branch of the run, for what looks a request up without knowing its repository. */
  async allBranches(run: Run): Promise<string[]> {
    const lines = parseBranchNames(await this.kernel.documents.latestBody(run.key, ARTIFACTS.branchNames.kind));
    return lines.size === 0 ? [await this.branch(run, null)] : [...new Set(lines.values())];
  }

  /** The branch the repository's current format gives for the run's latest change, which may differ from the stored one. */
  async renderedBranch(run: Run, repo: string): Promise<string> {
    const { change } = await this.change(run);
    const template = this.format(run, repo).branch;
    return branchName(run.key, await this.summary(run), { template, change });
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

  /** The meaning of the run's change: the host refusal's answer, else implement's own, else the plan's, else the one the parent's plan gave this task. */
  private async change(run: Run): Promise<{ change: GitChange | undefined; implemented: boolean }> {
    const refused = parseRefusal((await this.kernel.documents.latestBody(run.key, ARTIFACTS.gitRefusal.kind)) ?? '');
    if (refused) {
      return { change: refused.answer.change, implemented: true };
    }
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
