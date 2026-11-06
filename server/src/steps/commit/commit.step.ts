import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { existsSync, statSync } from 'fs';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { CheckoutRepository } from '../../history/checkout.repository';
import { root } from '../../history/run-paths';
import { StepName } from '../../contract/steps';
import { OpenedStep } from '../../steps/step-run';
import { SwarmloopError } from '../../core/swarmloop-error';
import { branchName, commitMessage, summaryForBranch } from '../branch/branch-name';
import { authorArgs, git, gitDetail, gitMissing, originUrl } from '../../git/git';
import { commitResult } from './commit-result';
import { gitAt, status, Tree } from './commit-git';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import { remoteProject } from '../merge-request/merge-request-record';
import { BaseStep, StepContext } from '../base-step';
import {
  allowedPaths,
  deniedIndexPaths,
  parsePaths,
  PlannedPath,
  renderPaths,
  stageSelection,
} from '../../git/commit-paths';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

export const CI_SKIPPED = 'CI skipped: there is no origin to push.';

/** `ci_skip` and `ci_rerun` are read where the path needs them, so a visit that stops earlier never reads them. */
const INPUTS = {
  requirements: { artifact: ARTIFACTS.requirements, need: 'start' },
  repos: { artifact: ARTIFACTS.repos, need: 'run' },
  commit: { artifact: ARTIFACTS.commit, need: 'optional' },
  ciSkip: { artifact: ARTIFACTS.ciSkip, need: 'optional', late: true },
  ciRerun: { artifact: ARTIFACTS.ciRerun, need: 'optional', late: true },
} as const satisfies InputSpec;

@Injectable()
export class CommitStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'commit';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.commit];

  constructor(
    kernel: StepKernel,
    private readonly checkouts: CheckoutRepository,
    private readonly registry: CodeHostRegistry,
  ) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { opened } = ctx;
    const { key } = opened.run;
    const { requirements } = input;
    if (!requirements?.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const summary = summaryForBranch(requirements, key);
    const branch = branchName(key, summary);
    const names = checkedRepoNames(input.repos);
    const trees = this.trees(key, names);
    await this.assertBranch(trees, branch);
    const phases = await this.flows.activePhases(opened.run.id);
    const stored = input.commit;
    const again = await this.resume(opened, stored);
    if (!phases.includes('ci') && !again) {
      const body = await this.preview(trees, branch);
      return commitResult('waiting', `${opened.startedAt} commit waiting\n${body.trimEnd()}`, body);
    }
    const planned = again ? parsePaths(stored ?? '') : await this.plan(trees, await this.checkouts.listDenyPaths());
    const rerun = planned.length === 0 && (await this.reader.newer(key, ARTIFACTS.ciRerun, ARTIFACTS.commit));
    if (!rerun && planned.length === 0 && !(await this.somethingToPush(trees, branch))) {
      if (await this.publishedHead(trees, branch)) {
        return commitResult('ok', `${opened.startedAt} commit done\n${branch}`);
      }
      throw new SwarmloopError('nothing to commit');
    }
    const heads: string[] = [];
    const pushed = rerun
      ? await this.republish(trees, branch, opened.run.codeHost, heads)
      : await this.publish(trees, planned, branch, commitMessage(key, summary), opened.run.codeHost);
    const listed = planned.length > 0 ? renderPaths(planned).trimEnd() : '';
    const recordedHeads = heads.length > 0 ? `${heads.join('\n')}\n` : undefined;
    if (!pushed) {
      await ctx.write(ARTIFACTS.ciSkip, `${CI_SKIPPED}\n`);
      const line = listed ? `${opened.startedAt} ${CI_SKIPPED}\n${listed}` : `${opened.startedAt} ${CI_SKIPPED}`;
      return commitResult('ok', line, listed ? `${listed}\n` : undefined);
    }
    const recorded = await this.rememberRefs(trees, branch, (body) => ctx.write(ARTIFACTS.pipelineRef, body));
    if (recorded) {
      const skip = await ctx.reread(ARTIFACTS.ciSkip);
      if (skip?.trim()) {
        await ctx.write(ARTIFACTS.ciSkip, '');
      }
    }
    const line = listed
      ? `${opened.startedAt} commit done\n${branch}\n${listed}`
      : `${opened.startedAt} commit done\n${branch}`;
    return commitResult('ok', line, listed ? `${listed}\n` : recordedHeads);
  }

  /** A failed or still-open commit retries its own path list. Arriving from the previous phase reads the tree again. */
  private async resume(opened: OpenedStep, stored: string | null): Promise<boolean> {
    if (!stored?.trim() || opened.previousStep !== 'commit') {
      return false;
    }
    if (opened.previousStatus === 'failed' || opened.previousStatus === 'running') {
      return true;
    }
    if (opened.previousStatus !== 'waiting') {
      return false;
    }
    const stats = await this.visits.listStats(opened.run.id);
    const last = [...stats].reverse().find((item) => item.step === 'commit');
    return last?.status === 'waiting';
  }

  private trees(key: string, names: string[]): Tree[] {
    return names.map((repo) => {
      const path = worktreePath(root(this.config), key, repo);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new SwarmloopError(`${repo} is not a worktree`);
      }
      return { repo, path };
    });
  }

  private async assertBranch(trees: Tree[], branch: string): Promise<void> {
    for (const tree of trees) {
      const current = await gitAt(tree, ['branch', '--show-current'], 'branch failed');
      if (current === 'main' || current === 'master') {
        throw new SwarmloopError(`${tree.repo} branch is protected`);
      }
      if (current !== branch) {
        throw new SwarmloopError(`${tree.repo} branch is missing`);
      }
    }
  }

  private async preview(trees: Tree[], branch: string): Promise<string> {
    const planned = await this.plan(trees, await this.checkouts.listDenyPaths());
    if (planned.length > 0) {
      return renderPaths(planned);
    }
    const pending: string[] = [];
    for (const tree of trees) {
      if (await this.ahead(tree, branch)) {
        pending.push(tree.repo);
      }
    }
    if (pending.length === 0) {
      throw new SwarmloopError('nothing to commit');
    }
    return `${pending.join('\n')}\n`;
  }

  private async plan(trees: Tree[], denied: string[]): Promise<PlannedPath[]> {
    const planned: PlannedPath[] = [];
    for (const tree of trees) {
      planned.push(...allowedPaths(tree.repo, await status(tree), denied));
    }
    return planned;
  }

  private async ahead(tree: Tree, branch: string): Promise<boolean> {
    const head = await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
    const remote = await this.optionalRev(tree, `refs/remotes/origin/${branch}`);
    if (remote) {
      return remote !== head;
    }
    const base =
      (await this.optionalRev(tree, 'refs/remotes/origin/main')) ??
      (await this.optionalRev(tree, 'refs/remotes/origin/master'));
    return base !== head;
  }

  private async optionalRev(tree: Tree, ref: string): Promise<string | null> {
    try {
      return await git(['-C', tree.path, 'rev-parse', '--verify', '--quiet', ref]);
    } catch (error) {
      if (gitMissing(error)) {
        return null;
      }
      throw new SwarmloopError(`${tree.repo} branch failed: ${gitDetail(error)}`);
    }
  }

  private async publishedHead(trees: Tree[], branch: string): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      if (!(await originUrl(cwd, tree.repo, 'origin failed'))) {
        continue;
      }
      const remote = await this.optionalRev(tree, `refs/remotes/origin/${branch}`);
      if (!remote) {
        continue;
      }
      const head = await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
      if (remote === head) {
        return true;
      }
    }
    return false;
  }

  private async somethingToPush(trees: Tree[], branch: string): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      if ((await originUrl(cwd, tree.repo, 'origin failed')) && (await this.ahead(tree, branch))) {
        return true;
      }
    }
    return false;
  }

  private async publish(
    trees: Tree[],
    planned: PlannedPath[],
    branch: string,
    message: string,
    codeHost: string,
  ): Promise<boolean> {
    const denied = await this.checkouts.listDenyPaths();
    const pushed = await Promise.all(
      trees.map((tree) => this.publishTree(tree, planned, branch, message, denied, codeHost)),
    );
    return pushed.some(Boolean);
  }

  /** Start CI again on a clean tree: push an unpublished HEAD, else push an empty commit. Fills `heads` with `<repo> <head>` per pushed repo. */
  private async republish(trees: Tree[], branch: string, codeHost: string, heads: string[]): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      const origin = await originUrl(cwd, tree.repo, 'origin failed');
      if (!origin) {
        continue;
      }
      const published = await this.optionalRev(tree, `refs/remotes/origin/${branch}`);
      if (published === (await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed'))) {
        await gitAt(
          tree,
          [...(await authorArgs(cwd)), 'commit', '--allow-empty', '--no-verify', '-m', 'Re-run CI'],
          'commit failed',
        );
      }
      await this.pushRef(tree, branch, published, codeHost, origin);
      heads.push(`${tree.repo} ${await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed')}`);
    }
    return heads.length > 0;
  }

  private async publishTree(
    tree: Tree,
    planned: PlannedPath[],
    branch: string,
    message: string,
    denied: string[],
    codeHost: string,
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
      await gitAt(tree, [...(await authorArgs(cwd)), 'commit', '--no-verify', '-m', message], 'commit failed');
    }
    const origin = await originUrl(cwd, tree.repo, 'origin failed');
    if (!origin) {
      return false;
    }
    const published = await this.optionalRev(tree, `refs/remotes/origin/${branch}`);
    return this.pushRef(tree, branch, published, codeHost, origin);
  }

  /** Push a rewritten branch with the tip captured before the base fetch. Does not stage or commit. */
  async publishRebased(key: string, branch: string, leases: { repo: string; tip: string | null }[]): Promise<void> {
    const run = await this.runs.findRun(key);
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
    await this.rememberRefs(trees, branch, (body) => this.store(run, ARTIFACTS.pipelineRef, body));
  }

  private async pushRef(
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
  private async rememberRefs(trees: Tree[], branch: string, write: (body: string) => Promise<void>): Promise<boolean> {
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
