import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { StepName } from '../../contract/steps';
import { OpenedStep } from '../../steps/step-run';
import { SwarmloopError, type HttpCallDraft } from '../../core/swarmloop-error';
import { baseBranch, originRef } from '../../git/base-ref';
import { commitIdentity, originUrl, type CommitAuthor } from '../../git/git';
import { commitResult, deliveredResult, undeliveredResult } from './commit-result';
import { unchangedOutcome } from './commit-delivered';
import { gitAt, status, Tree } from './commit-git';
import { checkedRepoNames } from '../../git/repo-names';
import { RunStop } from '../../agent/run-stop';
import { assertNotStopped } from '../../agent/step-stopped';
import { hasWorkToMerge } from '../shared/branch-work';
import { RunAuthor, type AuthoredRun } from '../shared/run-author';
import { RunNames } from '../shared/run-names';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { finishedRuns, rerunJobs } from '../pipeline/ci-host';
import { atBranchHeads } from '../pipeline/branch-heads';
import { loadSeen } from '../pipeline/load-seen';
import { parsePipelineRefs } from '../pipeline/pipeline-report';
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
  pipelineRef: { artifact: ARTIFACTS.pipelineRef, need: 'optional', late: true },
} as const satisfies InputSpec;

@Injectable()
export class CommitStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'commit';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.commit, ARTIFACTS.pipelineRef, ARTIFACTS.ciSkip, ARTIFACTS.issues];

  constructor(
    kernel: StepKernel,
    private readonly publisher: RebasedPublisher,
    private readonly runNames: RunNames,
    private readonly runAuthor: RunAuthor,
    private readonly registry: CodeHostRegistry,
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
    const named = baseBranch(opened.run.prompt);
    const names = checkedRepoNames(input.repos);
    const branch = await this.runNames.branch(opened.run, names[0]);
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
    const planned = again ? parsePaths(stored ?? '') : await this.plan(trees, []);
    const rerun = planned.length === 0 && (await this.reader.newer(key, ARTIFACTS.ciRerun, ARTIFACTS.commit));
    if (!rerun && planned.length === 0) {
      if (!(await this.hasWork(trees, named))) {
        return this.unchanged(opened);
      }
      if (!(await this.somethingToPush(trees, branch, named))) {
        if (await this.publishedHead(trees, branch)) {
          await this.publisher.rememberRefs(trees, branch, (body) => ctx.write(ARTIFACTS.pipelineRef, body));
          await this.publisher.stampRefs(opened.run, trees);
          return commitResult('ok', `${opened.startedAt} commit done\n${branch}`);
        }
        return this.unchanged(opened);
      }
    }
    assertNotStopped(this.runStop, key);
    const heads: string[] = [];
    const message = await this.runNames.commitMessage(opened.run, names[0]);
    const pushed = await ctx.activity(
      `Commit ${planned.length} files`,
      () =>
        rerun
          ? this.republish(trees, branch, opened.run, heads, ctx)
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
    return last?.status === 'waiting' || last?.status === 'failed';
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
    const planned = await this.plan(trees, []);
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
    return (await this.baseRev(tree, named)) !== head;
  }

  private async baseRev(tree: Tree, named: string | null): Promise<string | null> {
    return named
      ? await this.publisher.optionalRev(tree, `refs/remotes/${originRef(named)}`)
      : ((await this.publisher.optionalRev(tree, 'refs/remotes/origin/main')) ??
          (await this.publisher.optionalRev(tree, 'refs/remotes/origin/master')));
  }

  /** A branch is work only when it has a commit its target does not have. */
  private async hasWork(trees: Tree[], named: string | null): Promise<boolean> {
    for (const tree of trees) {
      if (await hasWorkToMerge(tree, await this.baseRev(tree, named))) {
        return true;
      }
    }
    return false;
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
    run: AuthoredRun,
  ): Promise<boolean> {
    const author = await this.runAuthor.of(run);
    const pushed = await Promise.all(
      trees.map((tree) => this.publishTree(tree, planned, branch, message, [], run, author)),
    );
    return pushed.some(Boolean);
  }

  /**
   * Start CI again on a clean tree: push an unpublished HEAD; when origin already has HEAD, ask the host to run the
   * failed jobs of the branch's last pipeline again. Fills `heads` with `<repo> <head>` per repo that has an origin.
   */
  private async republish(
    trees: Tree[],
    branch: string,
    run: PublishedBy,
    heads: string[],
    ctx: StepContext,
  ): Promise<boolean> {
    let again = false;
    for (const tree of trees) {
      const cwd = tree.path;
      const origin = await originUrl(cwd, tree.repo, 'origin failed');
      if (!origin) {
        continue;
      }
      const published = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch}`);
      if (published === (await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed'))) {
        again = true;
      } else {
        await this.publisher.pushRef(tree, branch, published, run, origin);
      }
      heads.push(`${tree.repo} ${await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed')}`);
    }
    if (again) {
      await this.rerunFailedJobs(run, await ctx.reread(ARTIFACTS.pipelineRef), ctx.calls);
    }
    return heads.length > 0;
  }

  /** The host runs the failed jobs of the recorded branches again. A host outage is a wait, a refusal is an error with the host's text. */
  private async rerunFailedJobs(run: PublishedBy, refs: string | null, calls: HttpCallDraft[]): Promise<void> {
    const host = await this.registry.hostFor(run);
    const records = await atBranchHeads(host, parsePipelineRefs(refs ?? ''), calls);
    const seen = await loadSeen(records, calls, host, false);
    const errors = await rerunJobs(host, finishedRuns(seen), calls);
    if (errors.length > 0) {
      throw new SwarmloopError(`CI re-run refused: ${errors.join('; ')}`);
    }
  }

  private async publishTree(
    tree: Tree,
    planned: PlannedPath[],
    branch: string,
    message: string,
    denied: string[],
    run: PublishedBy,
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
      await gitAt(tree, [...identity.args, 'commit', '--no-verify', '-m', message], 'commit failed', identity.env);
    }
    const origin = await originUrl(cwd, tree.repo, 'origin failed');
    if (!origin) {
      return false;
    }
    const published = await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch}`);
    return this.publisher.pushRef(tree, branch, published, run, origin);
  }
}
