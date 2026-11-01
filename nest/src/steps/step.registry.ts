import { Injectable } from '@nestjs/common';
import { StepName } from '../pipeline/pipeline-result';
import { BranchService } from './branch/branch.service';
import { CommitService } from './commit/commit.service';
import { CodeReviewService } from './code-review/code-review.service';
import { ImplementImproveService } from './implement/implement-improve.service';
import { ImplementService } from './implement/implement.service';
import { MergeRequestService } from './merge-request/merge-request.service';
import { PlanImproveService } from './plan/plan-improve.service';
import { PlanService } from './plan/plan.service';
import { PipelineStepService } from './pipeline/pipeline-step.service';
import { PrepareService } from './prepare/prepare.service';
import { RequirementsService } from './requirements/requirements.service';
import { ResearchService } from './research/research.service';
import { Step } from './step';

/** Every step with a service, by name. `done` has none. */
@Injectable()
export class StepRegistry {
  private readonly steps = new Map<StepName, Step>();

  constructor(
    requirements: RequirementsService,
    prepare: PrepareService,
    research: ResearchService,
    branch: BranchService,
    plan: PlanService,
    planImprove: PlanImproveService,
    implement: ImplementService,
    implementImprove: ImplementImproveService,
    codeReview: CodeReviewService,
    commit: CommitService,
    mergeRequest: MergeRequestService,
    pipelineStep: PipelineStepService,
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
