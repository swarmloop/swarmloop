import { Module, type OnModuleInit } from '@nestjs/common';
import { RunStop } from '../agent/run-stop';
import { HaltedRuns } from '../core/halted-runs';
import { HistoryModule } from '../history/history.module';
import { ProvidersModule } from '../integrations/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { SandboxService } from '../sandbox/sandbox.service';
import { FootprintRepository } from '../history/footprint.repository';
import { BranchStep } from '../steps/branch/branch.step';
import { CommitStep } from '../steps/commit/commit.step';
import { BranchCheckout } from '../steps/shared/branch-checkout';
import { CheckoutService } from '../steps/shared/checkout.service';
import { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { MergeRequestStep } from '../steps/merge-request/merge-request.step';
import { MergeRequestLookup } from '../steps/merge-request/merge-request-lookup';
import { CodeReviewStep } from '../steps/code-review/code-review.step';
import { ChecksStep } from '../steps/checks/checks.step';
import { ImplementImproveStep } from '../steps/implement/implement-improve.step';
import { ImplementStep } from '../steps/implement/implement.step';
import { SplitImplementStep } from '../steps/implement/split-implement.step';
import { SplitMerge } from '../steps/implement/split-merge';
import { SplitRebase } from '../steps/implement/split-rebase';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { SubtaskPort } from './subtask-port';
import { PlanImproveStep } from '../steps/plan-improve/plan-improve.step';
import { PipelineStep } from '../steps/pipeline/pipeline.step';
import { PlanStep } from '../steps/plan/plan.step';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { RemoteRepositories } from '../steps/prepare/remote-repositories.service';
import { RequirementsStep } from '../steps/requirements/requirements.step';
import { ResearchStep } from '../steps/research/research.step';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { LimitFailover } from '../steps/shared/limit-failover';
import { StepKernel } from '../steps/step-kernel';
import { StepRegistry } from '../steps/step.registry';
import { EnvironmentService } from '../environment/environment.service';
import { DiskGuard } from './disk-guard';
import { Housekeeping } from './housekeeping';
import { OwnUseMeter } from './own-use-meter';
import { RunRetention } from './run-retention';
import { WorkspaceGuard } from './workspace-guard';
import { CommandService } from './command.service';
import { MergeWatch } from './merge-watch';
import { Reconciler } from './reconciler';
import { RunSettler } from './run-settler';
import { PipelineService } from './pipeline.service';
import { AuthModule } from '../auth/auth.module';
import { RunRebase, RunRebaseEnvironment } from '../steps/run-rebase';
import { MergeRequestDrafts } from '../steps/merge-request/merge-request-draft';

@Module({
  imports: [HistoryModule, ProvidersModule, SandboxModule, AuthModule],
  providers: [
    RequirementsStep,
    PrepareStep,
    ProjectAppendService,
    RemoteRepositories,
    ResearchStep,
    BranchStep,
    CommitStep,
    RebasedPublisher,
    CheckoutService,
    BranchCheckout,
    WorkspaceGuard,
    RunRetention,
    DiskGuard,
    OwnUseMeter,
    Housekeeping,
    MergeRequestStep,
    MergeRequestLookup,
    PipelineStep,
    PlanStep,
    PlanImproveStep,
    ImplementStep,
    SplitImplementStep,
    SplitMerge,
    SplitRebase,
    SubtaskPort,
    { provide: SubtaskOps, useExisting: SubtaskPort },
    ImplementImproveStep,
    ChecksStep,
    CodeReviewStep,
    AgentLauncher,
    LimitFailover,
    StepKernel,
    StepRegistry,
    PipelineService,
    CommandService,
    MergeWatch,
    Reconciler,
    RunSettler,
    RunRebase,
    MergeRequestDrafts,
    { provide: RunRebaseEnvironment, useExisting: EnvironmentService },
    EnvironmentService,
    { provide: HaltedRuns, useExisting: RunStop },
  ],
  exports: [
    PipelineService,
    CommandService,
    Reconciler,
    SubtaskPort,
    Housekeeping,
    WorkspaceGuard,
    DiskGuard,
    OwnUseMeter,
    RunRebase,
    PrepareStep,
    ProjectAppendService,
    RemoteRepositories,
    CommitStep,
    RebasedPublisher,
    HistoryModule,
    EnvironmentService,
    AgentLauncher,
    StepRegistry,
  ],
})
export class PipelineModule implements OnModuleInit {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly footprints: FootprintRepository,
  ) {}

  onModuleInit(): void {
    this.sandbox.useFootprints(this.footprints);
  }
}
