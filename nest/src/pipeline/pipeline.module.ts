import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { ProvidersModule } from '../providers/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { BranchService } from '../steps/branch/branch.service';
import { CommitService } from '../steps/commit/commit.service';
import { MergeRequestService } from '../steps/merge-request/merge-request.service';
import { CodeReviewService } from '../steps/code-review/code-review.service';
import { ImplementImproveService } from '../steps/implement/implement-improve.service';
import { ImplementService } from '../steps/implement/implement.service';
import { PlanImproveService } from '../steps/plan/plan-improve.service';
import { PipelineStepService } from '../steps/pipeline/pipeline-step.service';
import { PlanService } from '../steps/plan/plan.service';
import { PrepareService } from '../steps/prepare/prepare.service';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { RequirementsService } from '../steps/requirements/requirements.service';
import { ResearchService } from '../steps/research/research.service';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [HistoryModule, ProvidersModule, SandboxModule],
  providers: [
    RequirementsService,
    PrepareService,
    ProjectAppendService,
    ResearchService,
    BranchService,
    CommitService,
    MergeRequestService,
    PipelineStepService,
    PlanService,
    PlanImproveService,
    ImplementService,
    ImplementImproveService,
    CodeReviewService,
    PipelineService,
  ],
  exports: [PipelineService, PrepareService, ProjectAppendService, CommitService, HistoryModule],
})
export class PipelineModule {}
