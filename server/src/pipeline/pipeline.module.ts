import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { ProvidersModule } from '../integrations/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { BranchStep } from '../steps/branch/branch.step';
import { CommitStep } from '../steps/commit/commit.step';
import { BranchCheckout } from '../steps/shared/branch-checkout';
import { CheckoutService } from '../steps/shared/checkout.service';
import { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { MergeRequestStep } from '../steps/merge-request/merge-request.step';
import { CodeReviewStep } from '../steps/code-review/code-review.step';
import { ImplementImproveStep } from '../steps/implement/implement-improve.step';
import { ImplementStep } from '../steps/implement/implement.step';
import { PlanImproveStep } from '../steps/plan-improve/plan-improve.step';
import { PipelineStep } from '../steps/pipeline/pipeline.step';
import { PlanStep } from '../steps/plan/plan.step';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { RequirementsStep } from '../steps/requirements/requirements.step';
import { ResearchStep } from '../steps/research/research.step';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { StepKernel } from '../steps/step-kernel';
import { StepRegistry } from '../steps/step.registry';
import { EnvironmentService } from '../environment/environment.service';
import { PipelineService } from './pipeline.service';
import { RunRebase, RunRebaseEnvironment } from '../steps/run-rebase';

@Module({
  imports: [HistoryModule, ProvidersModule, SandboxModule],
  providers: [
    RequirementsStep,
    PrepareStep,
    ProjectAppendService,
    ResearchStep,
    BranchStep,
    CommitStep,
    RebasedPublisher,
    CheckoutService,
    BranchCheckout,
    MergeRequestStep,
    PipelineStep,
    PlanStep,
    PlanImproveStep,
    ImplementStep,
    ImplementImproveStep,
    CodeReviewStep,
    AgentLauncher,
    StepKernel,
    StepRegistry,
    PipelineService,
    RunRebase,
    { provide: RunRebaseEnvironment, useExisting: EnvironmentService },
    EnvironmentService,
  ],
  exports: [
    PipelineService,
    RunRebase,
    PrepareStep,
    ProjectAppendService,
    CommitStep,
    RebasedPublisher,
    HistoryModule,
    EnvironmentService,
    AgentLauncher,
    StepRegistry,
  ],
})
export class PipelineModule {}
