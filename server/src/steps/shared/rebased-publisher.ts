import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { root } from '../../history/run-paths';
import { barrier } from '../../core/barrier';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing, originUrl } from '../../git/git';
import { withGitHostRetries } from '../../git/host-retry';
import { worktreePath } from '../../git/repo-names';
import { gitAt, Tree } from '../commit/commit-git';
import { remoteProject } from '../merge-request/merge-request-record';
import { ARTIFACTS } from '../contract/artifacts';
import { StepKernel } from '../step-kernel';
import { stampGate, worktreesFingerprint } from './gate';
import type { RunEntity } from '../../history/entities';
import type { RebaseHosts } from '../../git/rebase/types';

/** The fields of a run a push needs: the host, and whose token it uses. */
export type PublishedBy = Pick<RunEntity, 'codeHost' | 'startedBy'>;

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

  async optionalRev(tree: Tree, ref: string): Promise<string | null> {
    try {
      return await git(['-C', tree.path, 'rev-parse', '--verify', '--quiet', ref], undefined, { answers: [1] });
    } catch (error) {
      if (gitMissing(error)) {
        return null;
      }
      throw new SwarmloopError(`${tree.repo} branch failed: ${gitDetail(error)}`);
    }
  }

  /** Push a rewritten branch with the tip captured before the base fetch. Does not stage or commit. */
  async publishRebased(key: string, branch: string, leases: { repo: string; tip: string | null }[]): Promise<void> {
    const run = await this.kernel.runs.findRun(key);
    if (!run) {
      throw new SwarmloopError(`${key} is missing`);
    }
    const trees = this.trees(
      key,
      leases.map((lease) => lease.repo),
    );
    for (const tree of trees) {
      const cwd = tree.path;
      const origin = await originUrl(cwd, tree.repo, 'origin failed');
      if (!origin) {
        continue;
      }
      const captured = leases.find((lease) => lease.repo === tree.repo)?.tip ?? null;
      await this.pushRef(tree, branch, captured, run, origin);
    }
    await this.rememberRefs(trees, branch, (body) =>
      this.kernel.documents.putDocument(run, ARTIFACTS.pipelineRef.kind, ARTIFACTS.pipelineRef.format(body)),
    );
    await this.stampRefs(run, trees);
  }

  /** Ties the published SHAs, and so the CI result read next to them, to this generation and these files. */
  async stampRefs(run: RunEntity, trees: Tree[]): Promise<void> {
    const fingerprint = await worktreesFingerprint(trees.map((tree) => tree.path));
    await stampGate(this.kernel.documents, run, ARTIFACTS.pipelineRef.kind, fingerprint);
  }

  async pushRef(
    tree: Tree,
    branch: string,
    published: string | null,
    run: PublishedBy,
    origin: string,
  ): Promise<boolean> {
    const registry = await this.registry.forRun(run.startedBy, run.codeHost);
    const pushed = await this.pushChecked(tree, branch, published, run.codeHost, origin, registry);
    await barrier('after-push');
    return pushed;
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

  /** True when this push recorded a host project. A filesystem origin does not. */
  async rememberRefs(trees: Tree[], branch: string, write: (body: string) => Promise<void>): Promise<boolean> {
    const blocks: string[] = [];
    for (const tree of trees) {
      const cwd = tree.path;
      const url = await originUrl(cwd, tree.repo, 'origin failed');
      if (!url) {
        continue;
      }
      let project = '';
      try {
        project = remoteProject(url).project;
      } catch {
        continue;
      }
      const sha = await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
      blocks.push(`project: ${project}\nref: ${branch}\nsha: ${sha}`);
    }
    if (blocks.length === 0) {
      return false;
    }
    await write(`${blocks.join('\n\n')}\n`);
    return true;
  }
}
