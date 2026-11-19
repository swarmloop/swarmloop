import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { StepName } from '../../contract/steps';
import { checkedRepoNames } from '../../git/repo-names';
import { BaseStep, StepContext } from '../base-step';
import { originUrl } from '../../git/git';
import { BranchCheckout } from '../shared/branch-checkout';
import { RunNames } from '../shared/run-names';
import { GitRefusal } from '../shared/git-refusal';
import { RebasedPublisher } from '../shared/rebased-publisher';
import type { RunEntity } from '../../history/entities';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

const INPUTS = {
  requirements: { artifact: ARTIFACTS.requirements, need: 'run' },
  repos: { artifact: ARTIFACTS.repos, need: 'start' },
  pipelineRef: { artifact: ARTIFACTS.pipelineRef, need: 'optional' },
} as const satisfies InputSpec;

@Injectable()
export class BranchStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'branch';
  readonly inputs = INPUTS;
  readonly outputs = [];

  constructor(
    kernel: StepKernel,
    private readonly branches: BranchCheckout,
    private readonly names: RunNames,
    private readonly publisher: RebasedPublisher,
    private readonly refusal: GitRefusal,
  ) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { run } = ctx.opened;
    const { key } = run;
    const repos = checkedRepoNames(input.repos ?? []);
    const splits = await this.splits(ctx);
    const lines = await this.names.store(run, repos);
    const branchOf = (repo: string): string => lines.get(repo) ?? '';
    let name = [...new Set(repos.map(branchOf))].join(', ');
    // A run that has committed owns the commits of its branch. Before that, a branch of the same name was left by
    // an earlier run of this key, such as one removed in the panel.
    const committed = input.pipelineRef !== null;
    await ctx.activity(
      `Check out ${name}`,
      async () => {
        for (const repo of repos) {
          await this.branches.checkout(key, repo, branchOf(repo), committed);
        }
      },
      () => `on ${name}`,
    );
    if (splits) {
      await ctx.activity(
        `Push ${name}`,
        () => this.push(key, repos, run),
        () => 'to origin',
      );
      const pushed = await this.names.store(run, repos);
      name = [...new Set(repos.map((repo) => pushed.get(repo) ?? ''))].join(', ');
    }
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} branch done\n${name}`,
      outputs: [],
      handoff: `- checked out ${name}\n`,
    };
  }

  /** A run the planner split. Only a run that may split has a `subtasks` document to look for. */
  private async splits(ctx: StepContext): Promise<boolean> {
    return ctx.opened.run.split && ((await ctx.reread(ARTIFACTS.subtasks))?.length ?? 0) > 0;
  }

  /** The subtasks of a split run start from the feature branch, so it reaches origin before they do. A refused name is answered once. */
  private async push(key: string, repos: string[], run: RunEntity): Promise<void> {
    for (const tree of this.publisher.trees(key, repos)) {
      const origin = await originUrl(tree.path, tree.repo, 'origin failed');
      if (origin) {
        await this.refusal.guard({ run, repo: tree.repo, repos }, 'branch', async () =>
          this.publisher.pushRef(tree, await this.names.branch(run, tree.repo), null, run, origin, 'branch'),
        );
      }
    }
  }
}
