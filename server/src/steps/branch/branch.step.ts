import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { StepName } from '../../contract/steps';
import { checkedRepoNames } from '../../git/repo-names';
import { BaseStep, StepContext } from '../base-step';
import { originUrl } from '../../git/git';
import { BranchCheckout } from '../shared/branch-checkout';
import { RebasedPublisher } from '../shared/rebased-publisher';
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
    private readonly publisher: RebasedPublisher,
  ) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { key } = ctx.opened.run;
    const name = this.branches.branchFor(key, input.requirements);
    // A run that has committed owns the commits of its branch. Before that, a branch of the same name was left by
    // an earlier run of this key, such as one removed in the panel.
    const committed = input.pipelineRef !== null;
    const repos = checkedRepoNames(input.repos ?? []);
    await ctx.activity(
      `Check out ${name}`,
      async () => {
        for (const repo of repos) {
          await this.branches.checkout(key, repo, name, committed);
        }
      },
      () => `on ${name}`,
    );
    if (await this.splits(ctx)) {
      await ctx.activity(
        `Push ${name}`,
        () => this.push(key, repos, name, ctx.opened.run.codeHost),
        () => 'to origin',
      );
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

  /** The subtasks of a split run start from the feature branch, so it reaches origin before they do. */
  private async push(key: string, repos: string[], branch: string, codeHost: string): Promise<void> {
    for (const tree of this.publisher.trees(key, repos)) {
      const origin = await originUrl(tree.path, tree.repo, 'origin failed');
      if (origin) {
        await this.publisher.pushRef(tree, branch, null, codeHost, origin);
      }
    }
  }
}
