import type { Type } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { StepName } from '../contract/steps';
import { BranchStep } from '../steps/branch/branch.step';
import { ChecksStep } from '../steps/checks/checks.step';
import { CodeReviewStep } from '../steps/code-review/code-review.step';
import { CommitStep } from '../steps/commit/commit.step';
import { ImplementImproveStep } from '../steps/implement/implement-improve.step';
import { ImplementStep } from '../steps/implement/implement.step';
import { MergeRequestStep } from '../steps/merge-request/merge-request.step';
import { PipelineStep } from '../steps/pipeline/pipeline.step';
import { PlanImproveStep } from '../steps/plan-improve/plan-improve.step';
import { PlanStep } from '../steps/plan/plan.step';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { RequirementsStep } from '../steps/requirements/requirements.step';
import { ResearchStep } from '../steps/research/research.step';
import type { Step } from '../steps/step';

const SERVICES: Partial<Record<StepName, Type<Step>>> = {
  requirements: RequirementsStep,
  prepare: PrepareStep,
  research: ResearchStep,
  branch: BranchStep,
  plan: PlanStep,
  'plan-improve': PlanImproveStep,
  implement: ImplementStep,
  'implement-improve': ImplementImproveStep,
  checks: ChecksStep,
  'code-review': CodeReviewStep,
  commit: CommitStep,
  'merge-request': MergeRequestStep,
  pipeline: PipelineStep,
};

/** The step's real service from the compiled module. */
export function realStep(module: TestingModule, name: StepName): Step {
  const service = SERVICES[name];
  if (!service) throw new Error(`no real step named ${name}`);
  return module.get(service);
}
