import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { pushRejectionOfAnyHost } from '../../integrations/code-host/code-host-rules';
import { root } from '../../history/run-paths';
import { baseBranch, originRef } from '../../git/base-ref';
import { barrier } from '../../core/barrier';
import { GitRuleRefused } from '../../core/git-rule-refused';
import { GitRulesError, SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing, originUrl } from '../../git/git';
import { withGitHostRetries } from '../../git/host-retry';
import { worktreePath } from '../../git/repo-names';
import { withWorktree, withWorktrees } from '../../git/worktree-lock';
import { gitAt, Tree } from '../commit/commit-git';
import { remoteProject } from '../merge-request/merge-request-record';
import { ARTIFACTS } from '../contract/artifacts';
import { StepKernel } from '../step-kernel';
import { stampGate, worktreesFingerprint } from './gate';
import { hasWorkToMerge } from './branch-work';
import type { RunEntity } from '../../history/entities';
import type { RebaseHosts } from '../../git/rebase/types';
import { forRepo, type PerRepo } from '../../git/per-repo';

/** The fields of a run a push needs: the host, and whose token it uses. */
type PublishedBy = Pick<RunEntity, 'codeHost' | 'startedBy'>;

/** The fields of a run that say which base its branches start from. */
type BasedOn = Pick<RunEntity, 'prompt'>;

/** Pushes a branch to its origin and records the refs pushed. Commit and implement both publish through it. */
@Injectable()
export class RebasedPublisher {
  constructor(
    private readonly kernel: StepKernel,
    private readonly registry: CodeHostRegistry,
  ) {}

  /** What the server's git processes of a run read: the env, with the tokens of the person who started it. */
  async hostsFor(run: PublishedBy): Promise<RebaseHosts> {
    const { env } = this.kernel.config;
    return { ...env, ...(await this.registry.tokensFor(run.startedBy, run.codeHost)), clock: this.kernel.clock };
  }

  trees(key: string, names: string[]): Tree[] {
    return names.map((repo) => {
      const path = worktreePath(root(this.kernel.config), key, repo);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new SwarmloopError(`${repo} is not a worktree`);
      }
      return { repo, path };
    });
  }

  optionalRev(tree: Tree, ref: string): Promise<string | null> {
    return withWorktree(tree.path, async () => {
      try {
        return await git(['-C', tree.path, 'rev-parse', '--verify', '--quiet', ref], undefined, { answers: [1] });
      } catch (error) {
        if (gitMissing(error)) {
          return null;
        }
        throw new SwarmloopError(`${tree.repo} branch failed: ${gitDetail(error)}`);
      }
    });
  }

  /** The base a branch is measured against: the named one, else origin's main, else its master. Null when none is known. */
  async baseRev(tree: Tree, named: string | null): Promise<string | null> {
    return named
      ? await this.optionalRev(tree, `refs/remotes/${originRef(named)}`)
      : ((await this.optionalRev(tree, 'refs/remotes/origin/main')) ??
          (await this.optionalRev(tree, 'refs/remotes/origin/master')));
  }

  /** The one rule of what a run changed: a branch is the run's work only when it has a commit its base does not have. */
  async hasOwnWork(tree: Tree, named: string | null): Promise<boolean> {
    return hasWorkToMerge(tree, await this.baseRev(tree, named));
  }

  /**
   * Push a rewritten branch with the tip captured before the base fetch. Does not stage or commit. A repository the run
   * did not change is left alone, unless its branch is already on origin (an epic's early push) and must follow its base.
   */
  async publishRebased(
    key: string,
    branch: PerRepo<string>,
    leases: { repo: string; tip: string | null }[],
  ): Promise<void> {
    const run = await this.kernel.runs.findRun(key);
    if (!run) {
      throw new SwarmloopError(`${key} is missing`);
    }
    const trees = this.trees(
      key,
      leases.map((lease) => lease.repo),
    );
    for (const tree of trees) {
      const origin = await withWorktree(tree.path, () => originUrl(tree.path, tree.repo, 'origin failed'));
      if (!origin) {
        continue;
      }
      const captured = leases.find((lease) => lease.repo === tree.repo)?.tip ?? null;
      if (captured === null && !(await this.hasOwnWork(tree, baseBranch(run.prompt)))) {
        continue;
      }
      await this.refusedAsRule(() => this.pushRef(tree, forRepo(branch, tree.repo), captured, run, origin, 'commit'));
    }
    await this.rememberRefs(run, trees, branch, (body) =>
      this.kernel.documents.putDocument(run, ARTIFACTS.pipelineRef.kind, ARTIFACTS.pipelineRef.format(body)),
    );
    await this.stampRefs(run, trees);
  }

  /** Ties the published SHAs, and so the CI result read next to them, to this generation and these files. */
  async stampRefs(run: RunEntity, trees: Tree[]): Promise<void> {
    const paths = trees.map((tree) => tree.path);
    const fingerprint = await withWorktrees(paths, () => worktreesFingerprint(paths));
    await stampGate(this.kernel.documents, run, ARTIFACTS.pipelineRef.kind, fingerprint);
  }

  async pushRef(
    tree: Tree,
    branch: string,
    published: string | null,
    run: PublishedBy,
    origin: string,
    kind: 'branch' | 'commit',
  ): Promise<boolean> {
    const registry = await this.registry.forRun(run.startedBy, run.codeHost);
    const pushed = await withWorktree(tree.path, () =>
      this.pushChecked(tree, branch, published, run.codeHost, origin, registry).catch(async (error: unknown) => {
        await this.assertNotRuleRefusal(error, tree, branch, kind);
        throw error;
      }),
    );
    await barrier('after-push');
    return pushed;
  }

  /** A rebased push has no one to ask: a host rule that refuses it is a rule of the repository for a person to add. */
  private async refusedAsRule(push: () => Promise<boolean>): Promise<void> {
    try {
      await push();
    } catch (error) {
      throw error instanceof GitRuleRefused ? new GitRulesError(error.hostMessage, error.name) : error;
    }
  }

  /**
   * A push that ends in an error may still have landed. The remote tip says which: the pushed SHA means it is done,
   * the tip the lease expects means it never happened and the push runs again, anything else stops with the error.
   */
  private async pushChecked(
    tree: Tree,
    branch: string,
    published: string | null,
    codeHost: string,
    origin: string,
    registry: CodeHostRegistry,
  ): Promise<boolean> {
    try {
      return await this.push(tree, branch, published, codeHost, origin, registry);
    } catch (error) {
      let remote: string | null;
      try {
        remote = await this.remoteTip(tree, branch, codeHost, origin, registry);
      } catch {
        throw error;
      }
      const head = await gitAt(tree, ['rev-parse', 'HEAD'], 'push failed');
      if (remote === head) {
        await gitAt(tree, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], 'push failed');
        return true;
      }
      if (remote !== published) {
        throw error;
      }
      return this.push(tree, branch, published, codeHost, origin, registry);
    }
  }

  /**
   * A push the host refuses by a rule of the repository (not a lease or a non-fast-forward) is a `GitRuleRefused`: the
   * refused name is the branch, or the head commit's message for a commit.
   */
  private async assertNotRuleRefusal(
    error: unknown,
    tree: Tree,
    branch: string,
    kind: 'branch' | 'commit',
  ): Promise<void> {
    const prefix = `${tree.repo} push failed: `;
    const message = error instanceof SwarmloopError ? error.message : '';
    if (!message.startsWith(prefix) || !pushRejectionOfAnyHost([message.slice(prefix.length)])) {
      return;
    }
    const name = kind === 'branch' ? branch : (await gitAt(tree, ['log', '-1', '--format=%B'], 'push failed')).trim();
    throw new GitRuleRefused(message.slice(prefix.length), name, kind);
  }

  /** The tip of the branch on the remote, read from the remote itself. Null when the branch is not there. */
  private async remoteTip(
    tree: Tree,
    branch: string,
    codeHost: string,
    origin: string,
    registry: CodeHostRegistry,
  ): Promise<string | null> {
    const known = registry.has(codeHost);
    const url = known ? registry.byName(codeHost).pushUrl(origin) : null;
    const secret = known ? registry.credentials(codeHost).token : undefined;
    const listed = await this.reachingHost(url ?? origin, secret, () =>
      gitAt(
        tree,
        ['ls-remote', url ?? 'origin', `refs/heads/${branch}`],
        'push failed',
        { GIT_TERMINAL_PROMPT: '0' },
        secret,
      ),
    );
    return listed.split(/\s/)[0] || null;
  }

  private async push(
    tree: Tree,
    branch: string,
    published: string | null,
    codeHost: string,
    origin: string,
    registry: CodeHostRegistry,
  ): Promise<boolean> {
    const lease = published ? [`--force-with-lease=refs/heads/${branch}:${published}`] : [];
    if (!registry.has(codeHost)) {
      if (origin.startsWith('git@') || origin.startsWith('ssh://')) {
        throw new SwarmloopError('code host is missing');
      }
      await this.reachingHost(origin, undefined, () =>
        gitAt(tree, ['push', ...lease, '-u', 'origin', branch], 'push failed'),
      );
      return true;
    }
    const host = registry.credentials(codeHost);
    const url = registry.byName(codeHost).pushUrl(origin);
    if (url) {
      await this.reachingHost(url, host.token, () =>
        gitAt(
          tree,
          ['-c', `remote.origin.pushurl=${url}`, 'push', ...lease, 'origin', `HEAD:refs/heads/${branch}`],
          'push failed',
          { GIT_TERMINAL_PROMPT: '0' },
          host.token,
        ),
      );
      await gitAt(tree, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], 'push failed');
      return true;
    }
    if (origin.startsWith('git@') || origin.startsWith('ssh://')) {
      if (!host.token.trim()) {
        throw new SwarmloopError(`${tree.repo} push failed: ${host.tokenKey} is missing`);
      }
      if (!host.baseUrl.trim()) {
        throw new SwarmloopError(`${tree.repo} push failed: ${host.baseKey} is missing`);
      }
      throw new SwarmloopError(`${tree.repo} origin is not ${host.baseKey}`);
    }
    await this.reachingHost(origin, host.token, () =>
      gitAt(tree, ['push', ...lease, '-u', 'origin', branch], 'push failed'),
    );
    return true;
  }

  /** A git command that reaches the host: a passing outage is retried, then the step waits. */
  private reachingHost<T>(remote: string, secret: string | undefined, run: () => Promise<T>): Promise<T> {
    return withGitHostRetries(remote, this.kernel.clock, run, secret);
  }

  /** True when this push recorded a host project. A filesystem origin does not, and neither does a repository the run did not change. */
  async rememberRefs(
    run: BasedOn,
    trees: Tree[],
    branch: PerRepo<string>,
    write: (body: string) => Promise<void>,
  ): Promise<boolean> {
    const blocks: string[] = [];
    const named = baseBranch(run.prompt);
    for (const tree of trees) {
      if (!(await this.hasOwnWork(tree, named))) {
        continue;
      }
      const block = await withWorktree(tree.path, async () => {
        const url = await originUrl(tree.path, tree.repo, 'origin failed');
        if (!url) {
          return null;
        }
        let project = '';
        try {
          project = remoteProject(url).project;
        } catch {
          return null;
        }
        const sha = await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
        return `project: ${project}\nref: ${forRepo(branch, tree.repo)}\nsha: ${sha}`;
      });
      if (block) blocks.push(block);
    }
    if (blocks.length === 0) {
      return false;
    }
    await write(`${blocks.join('\n\n')}\n`);
    return true;
  }
}
