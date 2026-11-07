import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { root } from '../../history/run-paths';
import { barrier } from '../../core/barrier';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing, originUrl } from '../../git/git';
import { worktreePath } from '../../git/repo-names';
import { gitAt, Tree } from '../commit/commit-git';
import { remoteProject } from '../merge-request/merge-request-record';
import { ARTIFACTS } from '../contract/artifacts';
import { StepKernel } from '../step-kernel';

/** Pushes a branch to its origin and records the refs pushed. Commit and implement both publish through it. */
@Injectable()
export class RebasedPublisher {
  constructor(
    private readonly kernel: StepKernel,
    private readonly registry: CodeHostRegistry,
  ) {}

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
      return await git(['-C', tree.path, 'rev-parse', '--verify', '--quiet', ref]);
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
      await this.pushRef(tree, branch, captured, run.codeHost, origin);
    }
    await this.rememberRefs(trees, branch, (body) =>
      this.kernel.documents.putDocument(run, ARTIFACTS.pipelineRef.kind, ARTIFACTS.pipelineRef.format(body)),
    );
  }

  async pushRef(
    tree: Tree,
    branch: string,
    published: string | null,
    codeHost: string,
    origin: string,
  ): Promise<boolean> {
    const pushed = await this.push(tree, branch, published, codeHost, origin);
    await barrier('after-push');
    return pushed;
  }

  private async push(
    tree: Tree,
    branch: string,
    published: string | null,
    codeHost: string,
    origin: string,
  ): Promise<boolean> {
    const lease = published ? [`--force-with-lease=refs/heads/${branch}:${published}`] : [];
    if (!this.registry.has(codeHost)) {
      if (origin.startsWith('git@') || origin.startsWith('ssh://')) {
        throw new SwarmloopError('code host is missing');
      }
      await gitAt(tree, ['push', ...lease, '-u', 'origin', branch], 'push failed');
      return true;
    }
    const host = this.registry.credentials(codeHost);
    const url = this.registry.byName(codeHost).pushUrl(origin);
    if (url) {
      await gitAt(
        tree,
        ['-c', `remote.origin.pushurl=${url}`, 'push', ...lease, 'origin', `HEAD:refs/heads/${branch}`],
        'push failed',
        { GIT_TERMINAL_PROMPT: '0' },
        host.token,
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
    await gitAt(tree, ['push', ...lease, '-u', 'origin', branch], 'push failed');
    return true;
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
