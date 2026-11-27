import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { StepName } from '../../contract/steps';
import { OpenedStep } from '../../steps/step-run';
import { SwarmloopError } from '../../core/swarmloop-error';
import { baseBranch } from '../../git/base-ref';
import { originUrl } from '../../git/git';
import { commitResult, deliveredResult, undeliveredResult } from './commit-result';
import { unchangedOutcome, type BranchOnOrigin } from './commit-delivered';
import { gitAt, status, Tree } from './commit-git';
import { checkedRepoNames } from '../../git/repo-names';
import { RunStop } from '../../agent/run-stop';
import { assertNotStopped } from '../../agent/step-stopped';
import { RunNames } from '../shared/run-names';
import { RebasedPublisher } from '../shared/rebased-publisher';
import { CommitPublish } from './commit-publish';
import { deliveryEntries } from './commit-delivery';
import { BaseStep, StepContext } from '../base-step';
import { allowedPaths, parsePaths, PlannedPath, renderPaths } from '../../git/commit-paths';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

export const CI_SKIPPED = 'CI skipped: there is no origin to push.';

/** `ci_skip`, `ci_rerun`, `pipeline_ref` and `delivery` are read where the path needs them, so a visit that stops earlier never reads them. */
const INPUTS = {
  requirements: { artifact: ARTIFACTS.requirements, need: 'start' },
  repos: { artifact: ARTIFACTS.repos, need: 'run' },
  commit: { artifact: ARTIFACTS.commit, need: 'optional' },
  ciSkip: { artifact: ARTIFACTS.ciSkip, need: 'optional', late: true },
  ciRerun: { artifact: ARTIFACTS.ciRerun, need: 'optional', late: true },
  pipelineRef: { artifact: ARTIFACTS.pipelineRef, need: 'optional', late: true },
  delivery: { artifact: ARTIFACTS.delivery, need: 'optional', late: true },
} as const satisfies InputSpec;

@Injectable()
export class CommitStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'commit';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.commit, ARTIFACTS.pipelineRef, ARTIFACTS.ciSkip, ARTIFACTS.issues, ARTIFACTS.delivery];

  constructor(
    kernel: StepKernel,
    private readonly publisher: RebasedPublisher,
    private readonly runNames: RunNames,
    private readonly runStop: RunStop,
    private readonly commitPublish: CommitPublish,
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
    const named = baseBranch(opened.run.prompt);
    const names = checkedRepoNames(input.repos);
    const branch = await this.runNames.branchOf(opened.run, names);
    const label = [...new Set(names.map(branch))].join(', ');
    const trees = this.publisher.trees(key, names);
    await this.assertBranch(trees, branch);
    const phases = await this.flows.activePhases(opened.run.id);
    const stored = input.commit;
    const again = await this.resume(opened, stored);
    if (!phases.includes('ci') && !again) {
      const body = await this.preview(trees, branch, named);
      if (body === null) {
        return this.unchanged(ctx, trees, branch, named);
      }
      return commitResult('waiting', `${opened.startedAt} commit waiting\n${body.trimEnd()}`, body);
    }
    const planned = again ? parsePaths(stored ?? '') : await this.plan(trees, []);
    const rerun = planned.length === 0 && (await this.reader.newer(key, ARTIFACTS.ciRerun, ARTIFACTS.commit));
    if (!rerun && planned.length === 0) {
      if (!(await this.hasWork(trees, named))) {
        return this.unchanged(ctx, trees, branch, named);
      }
      if (!(await this.somethingToPush(trees, branch, named))) {
        if (await this.publishedHead(trees, branch)) {
          await this.publisher.rememberRefs(opened.run, trees, branch, (body) =>
            ctx.write(ARTIFACTS.pipelineRef, body),
          );
          await this.publisher.stampRefs(opened.run, trees);
          await this.recordDelivery(ctx, trees, named);
          return commitResult('ok', `${opened.startedAt} commit done\n${label}`);
        }
        return this.unchanged(ctx, trees, branch, named);
      }
    }
    assertNotStopped(this.runStop, key);
    const heads: string[] = [];
    const message = await this.runNames.commitMessage(opened.run, names[0]);
    const pushed = await ctx.activity(
      `Commit ${planned.length} files`,
      () =>
        rerun
          ? this.commitPublish.republish(trees, branch, opened.run, heads, ctx)
          : this.commitPublish.publish(
              trees,
              planned,
              (repo) => this.runNames.commitMessage(opened.run, repo),
              opened.run,
            ),
      () => message.split('\n')[0],
    );
    const listed = planned.length > 0 ? renderPaths(planned).trimEnd() : '';
    const recordedHeads = heads.length > 0 ? `${heads.join('\n')}\n` : undefined;
    if (!pushed) {
      await ctx.write(ARTIFACTS.ciSkip, `${CI_SKIPPED}\n`);
      await this.recordDelivery(ctx, trees, named);
      const line = listed ? `${opened.startedAt} ${CI_SKIPPED}\n${listed}` : `${opened.startedAt} ${CI_SKIPPED}`;
      return commitResult('ok', line, listed ? `${listed}\n` : undefined);
    }
    // An answered refusal may have renamed the branch while it was pushed.
    const pushedBranch = await this.runNames.branchOf(opened.run, names);
    const pushedLabel = [...new Set(names.map(pushedBranch))].join(', ');
    const recorded = await this.publisher.rememberRefs(opened.run, trees, pushedBranch, (body) =>
      ctx.write(ARTIFACTS.pipelineRef, body),
    );
    if (recorded) {
      await this.publisher.stampRefs(opened.run, trees);
      const skip = await ctx.reread(ARTIFACTS.ciSkip);
      if (skip?.trim()) {
        await ctx.write(ARTIFACTS.ciSkip, '');
      }
    }
    await this.recordDelivery(ctx, trees, named);
    const line = listed
      ? `${opened.startedAt} commit done\n${pushedLabel}\n${listed}`
      : `${opened.startedAt} commit done\n${pushedLabel}`;
    return commitResult('ok', line, listed ? `${listed}\n` : recordedHeads);
  }

  /** The delivery list of this pass: each repository with work of its own is publishing, the rest were only read. */
  private async recordDelivery(ctx: StepContext, trees: Tree[], named: string | null): Promise<void> {
    await ctx.write(ARTIFACTS.delivery, await deliveryEntries(this.publisher, trees, named));
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
    return last?.status === 'waiting' || last?.status === 'failed';
  }

  private async assertBranch(trees: Tree[], branch: (repo: string) => string): Promise<void> {
    for (const tree of trees) {
      const current = await gitAt(tree, ['branch', '--show-current'], 'branch failed');
      if (current === 'main' || current === 'master') {
        throw new SwarmloopError(`${tree.repo} branch is protected`);
      }
      if (current !== branch(tree.repo)) {
        throw new SwarmloopError(`${tree.repo} branch is missing`);
      }
    }
  }

  /** Nothing to commit is not an error: the task is already delivered, or the run goes back to implement. */
  private async unchanged(
    ctx: StepContext,
    trees: Tree[],
    branch: (repo: string) => string,
    named: string | null,
  ): Promise<StepResult> {
    const { opened } = ctx;
    await this.recordDelivery(ctx, trees, named);
    const hosts = await this.publisher.hostsFor(opened.run);
    const branches: BranchOnOrigin[] = [];
    for (const tree of trees) {
      const base =
        (await this.publisher.baseRev(tree, named)) ?? (await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed'));
      branches.push({ tree, branch: branch(tree.repo), base, hosts });
    }
    const outcome = await unchangedOutcome(this.kernel.documents, opened.run.key, branches);
    return 'delivered' in outcome
      ? deliveredResult(opened.startedAt, outcome.delivered)
      : undeliveredResult(opened.startedAt, outcome.issues);
  }

  /** The paths a commit would take, or null when the tree is unchanged. */
  private async preview(trees: Tree[], branch: (repo: string) => string, named: string | null): Promise<string | null> {
    const planned = await this.plan(trees, []);
    if (planned.length > 0) {
      return renderPaths(planned);
    }
    const pending: string[] = [];
    for (const tree of trees) {
      if (await this.ahead(tree, branch(tree.repo), named)) {
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
    return (await this.publisher.baseRev(tree, named)) !== head;
  }

  /** A branch is work only when it has a commit its target does not have. */
  private async hasWork(trees: Tree[], named: string | null): Promise<boolean> {
    for (const tree of trees) {
      if (await this.publisher.hasOwnWork(tree, named)) {
        return true;
      }
    }
    return false;
  }

  private async publishedHead(trees: Tree[], branch: (repo: string) => string): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      if (!(await originUrl(cwd, tree.repo, 'origin failed'))) {
        continue;
      }
      const remote = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch(tree.repo)}`);
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

  private async somethingToPush(
    trees: Tree[],
    branch: (repo: string) => string,
    named: string | null,
  ): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      if ((await originUrl(cwd, tree.repo, 'origin failed')) && (await this.ahead(tree, branch(tree.repo), named))) {
        return true;
      }
    }
    return false;
  }
}
