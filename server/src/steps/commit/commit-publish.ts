import { Injectable } from '@nestjs/common';
import { SwarmloopError, type HttpCallDraft } from '../../core/swarmloop-error';
import { baseBranch } from '../../git/base-ref';
import { commitIdentity, originUrl, type CommitAuthor } from '../../git/git';
import { withWorktree } from '../../git/worktree-lock';
import type { RunEntity } from '../../history/entities';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { finishedRuns, rerunJobs } from '../pipeline/ci-host';
import { atBranchHeads } from '../pipeline/branch-heads';
import { loadSeen } from '../pipeline/load-seen';
import { parsePipelineRefs } from '../pipeline/pipeline-report';
import { ARTIFACTS } from '../contract/artifacts';
import { GitRefusal } from '../shared/git-refusal';
import { RebasedPublisher } from '../shared/rebased-publisher';
import { RunAuthor } from '../shared/run-author';
import { RunNames } from '../shared/run-names';
import type { StepContext } from '../base-step';
import { deniedIndexPaths, PlannedPath, stageSelection } from '../../git/commit-paths';
import { gitAt, status, Tree } from './commit-git';

/** Commits the planned paths and pushes them, or starts CI again for a branch that is already pushed. */
@Injectable()
export class CommitPublish {
  constructor(
    private readonly publisher: RebasedPublisher,
    private readonly runAuthor: RunAuthor,
    private readonly registry: CodeHostRegistry,
    private readonly refusal: GitRefusal,
    private readonly names: RunNames,
  ) {}

  async publish(
    trees: Tree[],
    planned: PlannedPath[],
    message: (repo: string) => Promise<string>,
    run: RunEntity,
  ): Promise<boolean> {
    const author = await this.runAuthor.of(run);
    const pushed = await Promise.all(trees.map((tree) => this.publishTree(tree, planned, message, [], run, author)));
    return pushed.some(Boolean);
  }

  /**
   * Start CI again on a clean tree: push an unpublished HEAD; when origin already has HEAD, ask the host to run the
   * failed jobs of the branch's last pipeline again. Fills `heads` with `<repo> <head>` per repo that has an origin and
   * that the run changed.
   */
  async republish(
    trees: Tree[],
    branch: (repo: string) => string,
    run: RunEntity,
    heads: string[],
    ctx: StepContext,
  ): Promise<boolean> {
    let again = false;
    for (const tree of trees) {
      const origin = await withWorktree(tree.path, () => originUrl(tree.path, tree.repo, 'origin failed'));
      if (!origin || !(await this.publisher.hasOwnWork(tree, baseBranch(run.prompt)))) {
        continue;
      }
      const delivered = await withWorktree(tree.path, async () => {
        const published = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch(tree.repo)}`);
        return published === (await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed'));
      });
      if (delivered) {
        again = true;
      } else {
        // The lock is taken inside the work guard runs, never around guard: guard may ask the implement agent.
        await this.guarded(tree, run, origin);
      }
      heads.push(
        `${tree.repo} ${await withWorktree(tree.path, () => gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed'))}`,
      );
    }
    if (again) {
      await this.rerunFailedJobs(run, await ctx.reread(ARTIFACTS.pipelineRef), ctx.calls);
    }
    return heads.length > 0;
  }

  /** The host runs the failed jobs of the recorded branches again. A host outage is a wait, a refusal is an error with the host's text. */
  private async rerunFailedJobs(run: RunEntity, refs: string | null, calls: HttpCallDraft[]): Promise<void> {
    const host = await this.registry.hostFor(run);
    const records = await atBranchHeads(host, parsePipelineRefs(refs ?? ''), calls);
    const seen = await loadSeen(records, calls, host, false);
    const errors = await rerunJobs(host, finishedRuns(seen), calls);
    if (errors.length > 0) {
      throw new SwarmloopError(`CI re-run refused: ${errors.join('; ')}`);
    }
  }

  /**
   * Commits the tree's planned paths and pushes. A host rule that refuses the commit message is answered once: the unpushed
   * commit takes the message of the rule, then this runs again. The message is read when a commit is made.
   */
  private publishTree(
    tree: Tree,
    planned: PlannedPath[],
    message: (repo: string) => Promise<string>,
    denied: string[],
    run: RunEntity,
    author: CommitAuthor | null,
  ): Promise<boolean> {
    return this.refusal.guard({ run, repo: tree.repo, repos: [tree.repo] }, 'commit', () =>
      this.commitAndPush(tree, planned, message, denied, run, author),
    );
  }

  private commitAndPush(
    tree: Tree,
    planned: PlannedPath[],
    message: (repo: string) => Promise<string>,
    denied: string[],
    run: RunEntity,
    author: CommitAuthor | null,
  ): Promise<boolean> {
    return withWorktree(tree.path, () => this.commitAndPushHeld(tree, planned, message, denied, run, author));
  }

  private async commitAndPushHeld(
    tree: Tree,
    planned: PlannedPath[],
    message: (repo: string) => Promise<string>,
    denied: string[],
    run: RunEntity,
    author: CommitAuthor | null,
  ): Promise<boolean> {
    const cwd = tree.path;
    const wanted = new Set(planned.filter((item) => item.repo === tree.repo).map((item) => item.path));
    const porcelain = await status(tree);
    const held = deniedIndexPaths(porcelain, denied);
    if (held.length > 0) {
      await gitAt(tree, ['reset', '-q', 'HEAD', '--', ...held], 'commit failed');
    }
    const selection = stageSelection(porcelain, denied);
    const add = selection.add.filter((path) => wanted.has(path));
    const staged = selection.staged.filter((path) => wanted.has(path));
    if (add.length > 0) {
      await gitAt(tree, ['add', '--', ...add], 'commit failed');
    }
    if (add.length > 0 || staged.length > 0) {
      const identity = await commitIdentity(cwd, author);
      await gitAt(
        tree,
        [...identity.args, 'commit', '--no-verify', '-m', await message(tree.repo)],
        'commit failed',
        identity.env,
      );
    }
    const origin = await originUrl(cwd, tree.repo, 'origin failed');
    if (!origin || !(await this.publisher.hasOwnWork(tree, baseBranch(run.prompt)))) {
      return false;
    }
    return this.pushHead(tree, run, origin);
  }

  /** The push of a tree's branch. A host rule that refuses the commit message is answered once, then the push runs again. */
  private guarded(tree: Tree, run: RunEntity, origin: string): Promise<boolean> {
    return this.refusal.guard({ run, repo: tree.repo, repos: [tree.repo] }, 'commit', () =>
      this.pushHead(tree, run, origin),
    );
  }

  /** The branch is read as it is now: an answered refusal may have renamed it. */
  private pushHead(tree: Tree, run: RunEntity, origin: string): Promise<boolean> {
    return withWorktree(tree.path, async () => {
      const branch = await this.names.branch(run, tree.repo);
      const published = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch}`);
      return this.publisher.pushRef(tree, branch, published, run, origin, 'commit');
    });
  }
}
