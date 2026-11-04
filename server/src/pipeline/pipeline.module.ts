import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { ProvidersModule } from '../integrations/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { BranchStep } from '../steps/branch/branch.step';
import { CommitStep } from '../steps/commit/commit.step';
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
import { StepRegistry } from '../steps/step.registry';
import { EnvironmentService } from '../environment/environment.service';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [HistoryModule, ProvidersModule, SandboxModule],
  providers: [
    RequirementsStep,
    PrepareStep,
    ProjectAppendService,
    ResearchStep,
    BranchStep,
    CommitStep,
    MergeRequestStep,
    PipelineStep,
    PlanStep,
    PlanImproveStep,
    ImplementStep,
    ImplementImproveStep,
    CodeReviewStep,
    StepRegistry,
    PipelineService,
    EnvironmentService,
  ],
  exports: [PipelineService, PrepareStep, ProjectAppendService, CommitStep, HistoryModule],
})
export class PipelineModule {}
