import { Injectable } from '@nestjs/common';
import { StepName } from '../contract/steps';
import { BranchStep } from './branch/branch.step';
import { CommitStep } from './commit/commit.step';
import { CodeReviewStep } from './code-review/code-review.step';
import { ImplementImproveStep } from './implement/implement-improve.step';
import { ImplementStep } from './implement/implement.step';
import { MergeRequestStep } from './merge-request/merge-request.step';
import { PlanImproveStep } from './plan/plan-improve.step';
import { PlanStep } from './plan/plan.step';
import { PipelineStep } from './pipeline/pipeline.step';
import { PrepareStep } from './prepare/prepare.step';
import { RequirementsStep } from './requirements/requirements.step';
import { ResearchStep } from './research/research.step';
import { Step } from './step';

/** Every step with a service, by name. `done` has none. */
@Injectable()
export class StepRegistry {
  private readonly steps = new Map<StepName, Step>();

  constructor(
    requirements: RequirementsStep,
    prepare: PrepareStep,
    research: ResearchStep,
    branch: BranchStep,
    plan: PlanStep,
    planImprove: PlanImproveStep,
    implement: ImplementStep,
    implementImprove: ImplementImproveStep,
    codeReview: CodeReviewStep,
    commit: CommitStep,
    mergeRequest: MergeRequestStep,
    pipelineStep: PipelineStep,
  ) {
    const all: Step[] = [
      requirements,
      prepare,
      research,
      branch,
      plan,
      planImprove,
      implement,
      implementImprove,
      codeReview,
      commit,
      mergeRequest,
      pipelineStep,
    ];
    for (const step of all) {
      this.steps.set(step.name, step);
    }
  }

  get(name: StepName): Step | null {
    return this.steps.get(name) ?? null;
  }
}
