import { Module } from '@nestjs/common';
import { RunStop } from '../agent/run-stop';
import { HaltedRuns } from '../core/halted-runs';
import { HistoryModule } from '../history/history.module';
import { ProvidersModule } from '../integrations/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { BranchStep } from '../steps/branch/branch.step';
import { CommitStep } from '../steps/commit/commit.step';
import { CommitPublish } from '../steps/commit/commit-publish';
import { GitRefusal } from '../steps/shared/git-refusal';
import { BranchCheckout } from '../steps/shared/branch-checkout';
import { RunNames } from '../steps/shared/run-names';
import { RunAuthor } from '../steps/shared/run-author';
import { SubtaskRequestCloser } from '../steps/shared/subtask-requests-close';
import { GitRulesWriter } from '../steps/shared/git-rules-writer';
import { CheckoutService } from '../steps/shared/checkout.service';
import { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { RepositoryHost } from '../steps/shared/repository-host';
import { MergeLanding } from '../steps/shared/merge-landing';
import { MergedFilesRecord } from '../steps/shared/merged-files-record';
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
import { EpicRound } from '../steps/shared/epic-round';
import { EpicTasksMove } from '../steps/shared/epic-tasks-move';
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
import { AgentDoor } from '../steps/shared/agent-door';
import { AgentCallRecorder } from '../steps/shared/agent-call-recorder';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { CallContexts } from '../steps/shared/call-context';
import { SpendLimit } from '../steps/shared/spend-limit';
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
import { RunFolders } from './run-folders';
import { RunRetention } from './run-retention';
import { WorkspaceGuard } from './workspace-guard';
import { CommandService } from './command.service';
import { MergeWatch } from './merge-watch';
import { Reconciler } from './reconciler';
import { StartGate } from './start-gate';
import { RunGuards } from './run-guards';
import { PlannerTurns } from './planner-turns';
import { PlannerOwnTurn } from './planner-own-turn';
import { RunReopen } from './run-reopen';
import { BacklogActions } from './backlog/backlog-actions';
import { BacklogActionSupport } from './backlog/backlog-action-support';
import { BacklogRequirementActions } from './backlog/backlog-requirement-actions';
import { BacklogScopeActions } from './backlog/backlog-scope-actions';
import { BacklogTaskActions } from './backlog/backlog-task-actions';
import { TaskRunSkip } from './backlog/task-run-skip';
import { BacklogQueries } from './backlog/backlog-queries';
import { BacklogEvents } from './backlog/backlog-events';
import { BacklogMerge } from './backlog/backlog-merge';
import { EpicMainMoves } from './backlog/epic-main-moves';
import { MainRebaseSend } from './backlog/main-rebase-send';
import { MainWaitWake } from './backlog/main-wait-wake';
import { RedMainWait } from './backlog/red-main-wait';
import { MainHeld } from './backlog/main-held';
import { ServerStallWatch } from './server-stalls/server-stall-watch';
import { BacklogScheduler } from './backlog/backlog-scheduler';
import { OneActiveMilestone } from './backlog/one-active-milestone';
import { BacklogStartPort } from './backlog/backlog-start-port';
import { PlannerBacklogCalls } from './backlog/planner/planner-backlog-calls';
import { PlannerRules } from './backlog/planner/planner-rules';
import { PlannerRunPort } from './backlog/planner/planner-run-port';
import { BacklogPlanner } from './backlog/planner/backlog-planner';
import { PlannerTurnActions } from './backlog/planner/planner-actions';
import { LeftQuestions } from './backlog/planner/left-questions';
import { BacklogTurnPrompt } from './backlog/planner/turn-prompt';
import { BacklogTurnRunner } from './backlog/planner/turn-runner';
import { TurnTakes } from './backlog/planner/turn-takes';
import { TurnTies } from './backlog/planner/turn-ties';
import { BacklogTurnState } from './backlog/planner/turn-state';
import { BacklogTurnWorkspace } from './backlog/planner/turn-workspace';
import { EventFacts } from './backlog/planner/event-facts';
import { RunFacts } from './backlog/planner/run-facts';
import { RunReasons } from './backlog/planner/run-reason';
import { StallWatch } from './stall-watch';
import { StartWaits } from '../steps/shared/start-waits';
import { QuestionHolds } from '../steps/shared/question-holds';
import { QuestionPassOn } from './question-pass-on';
import { AttemptStream } from './attempt-stream';
import { RunSettler } from './run-settler';
import { MessageTurnEntry } from './message-turn-entry';
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
    CommitPublish,
    GitRefusal,
    RebasedPublisher,
    RepositoryOrigins,
    RepositoryHost,
    MergeLanding,
    MergedFilesRecord,
    CheckoutService,
    BranchCheckout,
    RunNames,
    RunAuthor,
    SubtaskRequestCloser,
    GitRulesWriter,
    WorkspaceGuard,
    RunFolders,
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
    EpicTasksMove,
    EpicRound,
    SubtaskPort,
    { provide: SubtaskOps, useExisting: SubtaskPort },
    ImplementImproveStep,
    ChecksStep,
    CodeReviewStep,
    AgentCallRecorder,
    CallContexts,
    AgentLauncher,
    AgentDoor,
    SpendLimit,
    LimitFailover,
    LimitRelease,
    RunReport,
    OpenReviewRounds,
    StaleReview,
    ReportRefresh,
    StepKernel,
    StepRegistry,
    PipelineService,
    { provide: MessageTurnEntry, useExisting: PipelineService },
    CommandService,
    StartGate,
    RunGuards,
    MergeWatch,
    Reconciler,
    StallWatch,
    StartWaits,
    QuestionHolds,
    QuestionPassOn,
    PlannerTurns,
    PlannerOwnTurn,
    PlanConversation,
    BacklogActionSupport,
    BacklogScopeActions,
    BacklogRequirementActions,
    BacklogTaskActions,
    TaskRunSkip,
    BacklogActions,
    BacklogQueries,
    BacklogEvents,
    BacklogMerge,
    EpicMainMoves,
    MainRebaseSend,
    MainWaitWake,
    RedMainWait,
    MainHeld,
    OneActiveMilestone,
    BacklogScheduler,
    ServerStallWatch,
    BacklogStartPort,
    PlannerRules,
    PlannerBacklogCalls,
    PlannerRunPort,
    PlannerTurnActions,
    LeftQuestions,
    EventFacts,
    RunFacts,
    RunReasons,
    BacklogTurnState,
    BacklogTurnPrompt,
    BacklogTurnWorkspace,
    BacklogTurnRunner,
    TurnTies,
    TurnTakes,
    BacklogPlanner,
    RunSettler,
    AttemptStream,
    RunRebase,
    MergeRequestDrafts,
    RunReopen,
    { provide: RunRebaseEnvironment, useExisting: EnvironmentService },
    EnvironmentService,
    { provide: HaltedRuns, useExisting: RunStop },
  ],
  exports: [
    PipelineService,
    RunFolders,
    CommandService,
    StartGate,
    Reconciler,
    PlannerTurns,
    QuestionHolds,
    QuestionPassOn,
    BacklogActions,
    BacklogQueries,
    BacklogScheduler,
    RedMainWait,
    BacklogPlanner,
    BacklogActionSupport,
    BacklogStartPort,
    PlannerRunPort,
    PlannerTurnActions,
    SubtaskPort,
    EpicTasksMove,
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
    MergeLanding,
    MergedFilesRecord,
    HistoryModule,
    EnvironmentService,
    AgentLauncher,
    AgentDoor,
    SpendLimit,
    RunReport,
    OpenReviewRounds,
    ReportRefresh,
    StepRegistry,
  ],
})
export class PipelineModule {}
