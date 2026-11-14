import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { CheckoutRepository } from '../../history/checkout.repository';
import { StepName } from '../../contract/steps';
import { OpenedStep } from '../../steps/step-run';
import { SwarmloopError } from '../../core/swarmloop-error';
import { branchName, commitMessage, summaryForBranch } from '../branch/branch-name';
import { baseBranch, originRef } from '../../git/base-ref';
import { authorArgs, originUrl } from '../../git/git';
import { commitResult, deliveredResult, undeliveredResult } from './commit-result';
import { unchangedOutcome } from './commit-delivered';
import { gitAt, status, Tree } from './commit-git';
import { checkedRepoNames } from '../../git/repo-names';
import { RunStop } from '../../agent/run-stop';
import { assertNotStopped } from '../../agent/step-stopped';
import { RebasedPublisher, type PublishedBy } from '../shared/rebased-publisher';
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
  readonly outputs = [ARTIFACTS.commit, ARTIFACTS.pipelineRef, ARTIFACTS.ciSkip, ARTIFACTS.issues];

  constructor(
    kernel: StepKernel,
    private readonly checkouts: CheckoutRepository,
    private readonly publisher: RebasedPublisher,
    private readonly runStop: RunStop,
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
    const named = baseBranch(opened.run.prompt);
    const names = checkedRepoNames(input.repos);
    const trees = this.publisher.trees(key, names);
    await this.assertBranch(trees, branch);
    const phases = await this.flows.activePhases(opened.run.id);
    const stored = input.commit;
    const again = await this.resume(opened, stored);
    if (!phases.includes('ci') && !again) {
      const body = await this.preview(trees, branch, named);
      if (body === null) {
        return this.unchanged(opened);
      }
      return commitResult('waiting', `${opened.startedAt} commit waiting\n${body.trimEnd()}`, body);
    }
    const planned = again ? parsePaths(stored ?? '') : await this.plan(trees, await this.checkouts.listDenyPaths());
    const rerun = planned.length === 0 && (await this.reader.newer(key, ARTIFACTS.ciRerun, ARTIFACTS.commit));
    if (!rerun && planned.length === 0 && !(await this.somethingToPush(trees, branch, named))) {
      if (await this.publishedHead(trees, branch)) {
        await this.publisher.stampRefs(opened.run, trees);
        return commitResult('ok', `${opened.startedAt} commit done\n${branch}`);
      }
      return this.unchanged(opened);
    }
    assertNotStopped(this.runStop, key);
    const heads: string[] = [];
    const message = commitMessage(key, summary);
    const pushed = await ctx.activity(
      `Commit ${planned.length} files`,
      () =>
        rerun
          ? this.republish(trees, branch, opened.run, heads)
          : this.publish(trees, planned, branch, message, opened.run),
      () => message.split('\n')[0],
    );
    const listed = planned.length > 0 ? renderPaths(planned).trimEnd() : '';
    const recordedHeads = heads.length > 0 ? `${heads.join('\n')}\n` : undefined;
    if (!pushed) {
      await ctx.write(ARTIFACTS.ciSkip, `${CI_SKIPPED}\n`);
      const line = listed ? `${opened.startedAt} ${CI_SKIPPED}\n${listed}` : `${opened.startedAt} ${CI_SKIPPED}`;
      return commitResult('ok', line, listed ? `${listed}\n` : undefined);
    }
    const recorded = await this.publisher.rememberRefs(trees, branch, (body) => ctx.write(ARTIFACTS.pipelineRef, body));
    if (recorded) {
      await this.publisher.stampRefs(opened.run, trees);
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

  /** Nothing to commit is not an error: the task is already delivered, or the run goes back to implement. */
  private async unchanged(opened: OpenedStep): Promise<StepResult> {
    const outcome = await unchangedOutcome(this.kernel.documents, opened.run.key);
    return 'delivered' in outcome
      ? deliveredResult(opened.startedAt, outcome.delivered)
      : undeliveredResult(opened.startedAt, outcome.issues);
  }

  /** The paths a commit would take, or null when the tree is unchanged. */
  private async preview(trees: Tree[], branch: string, named: string | null): Promise<string | null> {
    const planned = await this.plan(trees, await this.checkouts.listDenyPaths());
    if (planned.length > 0) {
      return renderPaths(planned);
    }
    const pending: string[] = [];
    for (const tree of trees) {
      if (await this.ahead(tree, branch, named)) {
        pending.push(tree.repo);
      }
    }
    if (pending.length === 0) {
      return null;
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

  private async ahead(tree: Tree, branch: string, named: string | null): Promise<boolean> {
    const head = await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
    const remote = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch}`);
    if (remote) {
      return remote !== head;
    }
    const base = named
      ? await this.publisher.optionalRev(tree, `refs/remotes/${originRef(named)}`)
      : ((await this.publisher.optionalRev(tree, 'refs/remotes/origin/main')) ??
        (await this.publisher.optionalRev(tree, 'refs/remotes/origin/master')));
    return base !== head;
  }

  private async publishedHead(trees: Tree[], branch: string): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      if (!(await originUrl(cwd, tree.repo, 'origin failed'))) {
        continue;
      }
      const remote = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch}`);
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

  private async somethingToPush(trees: Tree[], branch: string, named: string | null): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      if ((await originUrl(cwd, tree.repo, 'origin failed')) && (await this.ahead(tree, branch, named))) {
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
    run: PublishedBy,
  ): Promise<boolean> {
    const denied = await this.checkouts.listDenyPaths();
    const pushed = await Promise.all(
      trees.map((tree) => this.publishTree(tree, planned, branch, message, denied, run)),
    );
    return pushed.some(Boolean);
  }

  /** Start CI again on a clean tree: push an unpublished HEAD, else push an empty commit. Fills `heads` with `<repo> <head>` per pushed repo. */
  private async republish(trees: Tree[], branch: string, run: PublishedBy, heads: string[]): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      const origin = await originUrl(cwd, tree.repo, 'origin failed');
      if (!origin) {
        continue;
      }
      const published = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch}`);
      if (published === (await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed'))) {
        await gitAt(
          tree,
          [...(await authorArgs(cwd)), 'commit', '--allow-empty', '--no-verify', '-m', 'Re-run CI'],
          'commit failed',
        );
      }
      await this.publisher.pushRef(tree, branch, published, run, origin);
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
    run: PublishedBy,
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
    const published = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch}`);
    return this.publisher.pushRef(tree, branch, published, run, origin);
  }
}
