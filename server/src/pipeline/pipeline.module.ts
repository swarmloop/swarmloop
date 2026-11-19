import { Module } from '@nestjs/common';
import { RunStop } from '../agent/run-stop';
import { HaltedRuns } from '../core/halted-runs';
import { HistoryModule } from '../history/history.module';
import { ProvidersModule } from '../integrations/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { BranchStep } from '../steps/branch/branch.step';
import { CommitStep } from '../steps/commit/commit.step';
import { BranchCheckout } from '../steps/shared/branch-checkout';
import { RunNames } from '../steps/shared/run-names';
import { RunAuthor } from '../steps/shared/run-author';
import { GitRulesWriter } from '../steps/shared/git-rules-writer';
import { CheckoutService } from '../steps/shared/checkout.service';
import { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { RepositoryHost } from '../steps/shared/repository-host';
import { RepositoryOrigins } from '../steps/shared/repository-origins';
import { MergeRequestStep } from '../steps/merge-request/merge-request.step';
import { MergeRequestTemplate } from '../steps/merge-request/merge-request-template';
import { ImplementChat } from '../steps/shared/implement-chat';
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
import { RunReport } from '../steps/shared/run-report';
import { OpenReviewRounds } from '../steps/shared/open-review-rounds';
import { StaleReview } from '../steps/shared/stale-review';
import { ReportRefresh } from '../steps/shared/report-refresh';
import { LimitFailover } from '../steps/shared/limit-failover';
import { LimitRelease } from '../steps/shared/limit-release';
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
import { PlannerTurns } from './planner-turns';
import { RunReopen } from './run-reopen';
import { BacklogActions } from './backlog/backlog-actions';
import { BacklogActionSupport } from './backlog/backlog-action-support';
import { BacklogTaskActions } from './backlog/backlog-task-actions';
import { BacklogQueries } from './backlog/backlog-queries';
import { BacklogEvents } from './backlog/backlog-events';
import { BacklogMerge } from './backlog/backlog-merge';
import { ServerStallWatch } from './server-stalls/server-stall-watch';
import { BacklogScheduler } from './backlog/backlog-scheduler';
import { BacklogStartPort } from './backlog/backlog-start-port';
import { StallWatch } from './stall-watch';
import { RunSettler } from './run-settler';
import { PipelineService } from './pipeline.service';
import { AuthModule } from '../auth/auth.module';
import { RunRebase, RunRebaseEnvironment } from '../steps/run-rebase';
import { PlanConversation } from '../steps/shared/plan-conversation';
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
    RepositoryOrigins,
    RepositoryHost,
    CheckoutService,
    BranchCheckout,
    RunNames,
    RunAuthor,
    GitRulesWriter,
    WorkspaceGuard,
    RunRetention,
    DiskGuard,
    OwnUseMeter,
    Housekeeping,
    MergeRequestStep,
    MergeRequestTemplate,
    ImplementChat,
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
    LimitRelease,
    RunReport,
    OpenReviewRounds,
    StaleReview,
    ReportRefresh,
    StepKernel,
    StepRegistry,
    PipelineService,
    CommandService,
    MergeWatch,
    Reconciler,
    StallWatch,
    PlannerTurns,
    PlanConversation,
    BacklogActionSupport,
    BacklogTaskActions,
    BacklogActions,
    BacklogQueries,
    BacklogEvents,
    BacklogMerge,
    BacklogScheduler,
    ServerStallWatch,
    BacklogStartPort,
    RunSettler,
    RunRebase,
    MergeRequestDrafts,
    RunReopen,
    { provide: RunRebaseEnvironment, useExisting: EnvironmentService },
    EnvironmentService,
    { provide: HaltedRuns, useExisting: RunStop },
  ],
  exports: [
    PipelineService,
    CommandService,
    Reconciler,
    PlannerTurns,
    BacklogActions,
    BacklogQueries,
    BacklogScheduler,
    BacklogStartPort,
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
    RepositoryHost,
    HistoryModule,
    EnvironmentService,
    AgentLauncher,
    RunReport,
    OpenReviewRounds,
    ReportRefresh,
    StepRegistry,
  ],
})
export class PipelineModule {}
