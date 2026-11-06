import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { StepName } from '../../contract/steps';
import { checkedRepoNames } from '../../git/repo-names';
import { BaseStep, StepContext } from '../base-step';
import { BranchCheckout } from '../shared/branch-checkout';
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
  ) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { key } = ctx.opened.run;
    const name = this.branches.branchFor(key, input.requirements);
    // A run that has committed owns the commits of its branch. Before that, a branch of the same name was left by
    // an earlier run of this key, such as one removed in the panel.
    const committed = input.pipelineRef !== null;
    for (const repo of checkedRepoNames(input.repos ?? [])) {
      await this.branches.checkout(key, repo, name, committed);
    }
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} branch done\n${name}`,
      outputs: [],
      handoff: `- checked out ${name}\n`,
    };
  }
}
