import { BaseTips } from '../steps/shared/base-tips';
import { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { repoNames } from '../git/repo-names';
import { parseMergeRequests } from '../steps/merge-request/merge-request-record';
import { commitMessage, summaryForBranch } from '../git/naming/git-names';
import { storedBranch } from '../git/naming/stored-branch';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { ERROR_CODES } from '../contract/error-codes';
import { parseSubtasks, settled, SUBTASKS_KIND, withStatuses, type Subtask } from '../contract/subtask';
import {
  SubtaskOps,
  type SubtaskStart,
  type OwnEdits,
  type RebaseEvent,
  type ChainAsked,
  type ChainQuestion,
  type Escalated,
  type SubtaskMergeRequest,
} from '../steps/shared/subtask-ops';
import { disagrees } from '../steps/shared/subtask-status';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import { AgentDoor } from '../steps/shared/agent-door';
import type { Need } from '../steps/shared/needs';
import { mergeSummaryOf } from '../steps/shared/merge-summary';
import type { OpenedStep } from '../steps/step-run';
import { DELIVERED_PREFIX } from '../steps/commit/commit-result';
import { ReportRefresh } from '../steps/shared/report-refresh';
import type { RunAuthor } from '../steps/shared/run-author';
import type { RunNames } from '../steps/shared/run-names';
import { RunRebase } from '../steps/run-rebase';
import { CommandService } from './command.service';
import { StartGate } from './start-gate';
import { SubtaskWakes } from './subtask-wakes';
import { SubtaskEnd } from './subtask-end';
import { RunRetention } from './run-retention';
import { SubtaskWorktrees } from './subtask-worktrees';
import { SubtaskAsks } from './subtask-asks';
import { PlannerChain } from './planner-chain';
import { SubtaskMergeRecord } from './subtask-merge-record';
import { SubtaskRebases } from './subtask-rebases';
import { SubtaskRequestCloser } from '../steps/shared/subtask-requests-close';
import type { LookStart } from '../steps/shared/look-start';
import { PlanConversation } from '../steps/shared/plan-conversation';
import { QuestionHolds } from '../steps/shared/question-holds';
import { PlanChatStore } from '../history/plan-chat.store';
import type { PlanChange, StarterPlan } from '../steps/implement/starter-actions';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { StarterAnswerResult } from '../agent-result/definitions/starter-answer';

/** What the api layer does for the subtasks of a parent. It registers itself at init, so `pipeline` never imports `api`. */
interface SubtaskStarter {
  /** The waiting run of a task. It has no worktree until it starts. */
  open(parent: RunEntity, task: Subtask): Promise<RunEntity>;
  /** Starts the run of a task that `open` made. */
  launch(parent: RunEntity, task: Subtask): Promise<void>;
}

/** The shared operations on the subtask runs of a parent. Each one goes through the command door. */
@Injectable()
export class SubtaskPort extends SubtaskOps {
  private readonly logger = new Logger(SubtaskPort.name);
  private starter: SubtaskStarter | null = null;
  private readonly worktrees: SubtaskWorktrees;
  private readonly asks: SubtaskAsks;
  private readonly chain: PlannerChain;
  private readonly mergeRecord: SubtaskMergeRecord;
  private readonly wakes: SubtaskWakes;
  private readonly rebases: SubtaskRebases;
  private readonly end: SubtaskEnd;

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    commands: CommandService,
    door: AgentDoor,
    visits: VisitRepository,
    config: AppConfig,
    private readonly clock: Clock,
    gate: StartGate,
    @Optional() publisher?: RebasedPublisher,
    @Optional() private readonly rebaser?: RunRebase,
    @Optional() reportRefresh?: ReportRefresh,
    @Optional() conversation?: PlanConversation,
    @Optional() private readonly runNames?: RunNames,
    @Optional() private readonly runAuthor?: RunAuthor,
    @Optional() private readonly closer?: SubtaskRequestCloser,
    @Optional() retention?: RunRetention,
    @Optional() holds?: QuestionHolds,
  ) {
    super();
    this.worktrees = new SubtaskWorktrees(config, clock, new BaseTips(runs, documents), publisher);
    const planning =
      conversation ?? new PlanConversation(door, visits, documents, config, clock, new PlanChatStore(runs, documents));
    this.asks = new SubtaskAsks(documents, commands, gate, planning, visits, runs);
    this.chain = new PlannerChain(
      {
        askAbout: (opened, task, question, contract) => this.askAbout(opened, task, question, contract),
        handUp: (parent, taskId, text, words) => this.asks.handUp(parent, taskId, text, words),
      },
      planning,
      documents,
      runs,
      holds,
    );
    this.mergeRecord = new SubtaskMergeRecord(
      runs,
      documents,
      clock,
      this.worktrees,
      (parent) => this.branchOf(parent),
      reportRefresh,
      this.logger,
    );
    this.wakes = new SubtaskWakes(runs, commands, gate, visits, documents, this.logger);
    this.rebases = new SubtaskRebases(
      runs,
      documents,
      commands,
      rebaser,
      (run) => this.asking(run),
      (run) => this.mergeRequests(run),
      this.logger,
    );
    this.end = new SubtaskEnd(runs, this, this.logger, retention);
  }

  register(starter: SubtaskStarter): void {
    this.starter = starter;
  }

  open(parent: RunEntity, task: Subtask): Promise<RunEntity> {
    return this.started().open(parent, task);
  }

  launch(parent: RunEntity, task: Subtask): Promise<void> {
    return this.started().launch(parent, task);
  }

  override find(parent: RunEntity, taskId: string): Promise<RunEntity | null> {
    return this.runs.findSubtask(parent, taskId);
  }

  override async waitFor(run: RunEntity, message: string): Promise<void> {
    const reason = { code: ERROR_CODES.SUBTASK_WAITING, message };
    if (run.status !== 'waiting' || JSON.stringify(storedState(run).reason) === JSON.stringify(reason)) return;
    writeRunState(run, { status: 'waiting', reason });
    await this.runs.saveRun(run);
  }

  override asking(run: RunEntity): Promise<boolean> {
    return this.asks.asking(run);
  }

  override answer(
    opened: OpenedStep,
    child: RunEntity,
    task: Subtask,
    contract: string,
    plan?: StarterPlan,
    start?: LookStart,
  ): Promise<StarterAnswerResult | Escalated | null> {
    return this.asks.answer(opened, child, task, contract, plan, start);
  }

  override resend(child: RunEntity): Promise<StarterAnswerResult | null> {
    return this.asks.resend(child);
  }

  override recordRevisions(parent: RunEntity, changes: PlanChange[], at: string): Promise<void> {
    return this.asks.recordRevisions(parent, changes, at);
  }

  override replyPending(child: RunEntity): boolean {
    return this.asks.replyPending(child);
  }

  override deliverAnswer(child: RunEntity, text: string): Promise<void> {
    return this.asks.deliverAnswer(child, text);
  }

  override askAbout(
    opened: OpenedStep,
    task: Subtask,
    questions: string,
    contract: string,
  ): Promise<string | Escalated | null> {
    return this.asks.askAbout(opened, task, questions, contract);
  }

  override askUp(run: RunEntity, question: ChainQuestion, startLevel: number): Promise<ChainAsked> {
    return this.chain.askUp(run, question, startLevel);
  }

  /** The question the chain left open in the plan chat of the run for its planner, or null. */
  openQuestion(run: RunEntity): Promise<PlanChatEntry | null> {
    return this.chain.openQuestion(run);
  }

  override needsWrittenAt(run: RunEntity): Promise<string | null> {
    return this.documents.latestCreatedAt(run.key, ARTIFACTS.needs.kind);
  }

  override settledAt(parent: RunEntity, taskId: string): Promise<string | null> {
    return this.mergeRecord.settledAt(parent, taskId);
  }

  override async withoutCi(run: RunEntity): Promise<boolean> {
    return ((await this.documents.latestBody(run.key, 'pipeline_log')) ?? '').startsWith('result: none');
  }

  override async deliveredNote(run: RunEntity): Promise<string | null> {
    const body = ((await this.documents.latestBody(run.key, ARTIFACTS.commit.kind)) ?? '').trim();
    return body.startsWith(DELIVERED_PREFIX) ? body : null;
  }

  override needsOf(run: RunEntity): Promise<Need[]> {
    return this.asks.needsOf(run);
  }

  override mergeSummary(run: RunEntity): Promise<string> {
    return mergeSummaryOf(this.documents, run.key);
  }

  override async catchUp(parent: RunEntity, run: RunEntity): Promise<void> {
    await this.worktrees.catchUp(run, await this.reposOf(run), await this.branchOf(parent));
  }

  override async behindTip(parent: RunEntity, run: RunEntity): Promise<string | null> {
    return this.worktrees.behindTip(parent, run, await this.reposOf(run), await this.branchOf(parent));
  }

  override async conflictFiles(parent: RunEntity, run: RunEntity): Promise<string[]> {
    return this.worktrees.conflictFiles(run, await this.reposOf(run), await this.branchOf(parent));
  }

  private async reposOf(run: RunEntity): Promise<string[]> {
    return repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
  }

  override rerun(run: RunEntity, lines: string[], start?: SubtaskStart): Promise<void> {
    return this.asks.rerun(run, lines, start);
  }

  override resume(run: RunEntity): Promise<void> {
    return this.wakes.resume(run);
  }

  override async mergeRequests(run: RunEntity): Promise<SubtaskMergeRequest[]> {
    const body = await this.documents.latestBody(run.key, ARTIFACTS.mergeRequest.kind);
    if (!body?.trim()) return [];
    const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
    const records = parseMergeRequests(body);
    const positional = records.length === names.length;
    const projects = positional ? [] : await Promise.all(names.map((name) => this.worktrees.projectOf(run, name)));
    return records.map((record, index) => ({
      repo: (positional ? names[index] : names[projects.indexOf(record.project)]) ?? record.project,
      project: record.project,
      iid: record.iid,
    }));
  }

  override async branchOf(run: RunEntity): Promise<string> {
    const requirements = (await this.documents.latestBody(run.key, ARTIFACTS.requirements.kind)) ?? '';
    const stored = await this.documents.latestBody(run.key, ARTIFACTS.branchNames.kind);
    return storedBranch(stored, null, run.key, summaryForBranch(requirements, run.key));
  }

  override recordMerged(parent: RunEntity, run: RunEntity, merged: Record<string, string>): Promise<void> {
    return this.mergeRecord.recordMerged(parent, run, merged);
  }

  override async commitOwnEdits(parent: RunEntity, park: boolean): Promise<OwnEdits> {
    // A parent that has no repositories yet has no worktree to hold edits.
    if (!(await this.documents.latestBody(parent.key, ARTIFACTS.repos.kind))?.trim()) {
      return { committed: null, conflict: null };
    }
    const repos = await this.reposOf(parent);
    const commitAs = async () => ({
      message: this.runNames ? await this.runNames.commitMessageOf(parent, repos) : await this.builtInMessage(parent),
      author: (await this.runAuthor?.of(parent)) ?? null,
    });
    return this.worktrees.commitOwnEdits(parent, repos, await this.branchOf(parent), commitAs, park);
  }

  /** The built-in message, for a port built without the naming service. */
  private async builtInMessage(parent: RunEntity): Promise<() => string> {
    const requirements = (await this.documents.latestBody(parent.key, ARTIFACTS.requirements.kind)) ?? '';
    const message = commitMessage(parent.key, summaryForBranch(requirements, parent.key));
    return () => message;
  }

  override async fastForward(parent: RunEntity): Promise<string | null> {
    return this.worktrees.fastForward(parent, await this.reposOf(parent), await this.branchOf(parent));
  }

  override rebase(run: RunEntity, event?: RebaseEvent): Promise<boolean> {
    return this.rebases.rebase(run, event);
  }

  override keepsWait(run: RunEntity): Promise<boolean> {
    return this.rebases.keepsWait(run);
  }

  applyPendingRebase(key: string): Promise<string | null> {
    return this.rebases.applyPendingRebase(key);
  }

  rebaseOpen(parent: RunEntity, event?: RebaseEvent): Promise<void> {
    return this.rebases.rebaseOpen(parent, event);
  }

  /** The open merge requests of a subtask run a person skips. */
  async closeMergeRequests(parent: RunEntity, run: RunEntity): Promise<void> {
    await this.closer?.close(parent, run, () => this.mergeRequests(run), this.logger);
  }

  override closeSkipped(parent: RunEntity, run: RunEntity, reason: string): Promise<void> {
    return this.end.close(parent, run, reason);
  }

  resumeStopped(parent: RunEntity): Promise<void> {
    return this.wakes.resumeStopped(parent);
  }

  stop(run: RunEntity): Promise<void> {
    return this.wakes.stop(run);
  }

  stopAll(parent: RunEntity): Promise<void> {
    return this.wakes.stopAll(parent);
  }

  removeAll(parent: RunEntity): Promise<void> {
    return this.wakes.removeAll(parent);
  }

  notifyParent(key: string, idempotencyKey?: string): Promise<void> {
    return this.wakes.notifyParent(key, idempotencyKey);
  }

  leavingKey(key: string): Promise<string | null> {
    return this.wakes.leavingKey(key);
  }

  resumeParent(parent: RunEntity, idempotencyKey: string): Promise<void> {
    return this.wakes.resumeParent(parent, idempotencyKey);
  }

  /** True when the subtasks are not as the last pass saw them, or when no pass recorded them yet. */
  async subtasksChanged(parent: RunEntity): Promise<boolean> {
    if (parent.subtaskFingerprint === null) return true;
    if (parent.subtaskFingerprint !== (await this.runs.subtaskFingerprint(parent))) return true;
    return this.disagreeing(parent);
  }

  /** True when a task of the `subtasks` document has another status than its run gives, whatever the fingerprint says. */
  private async disagreeing(parent: RunEntity): Promise<boolean> {
    const tasks = withStatuses(parseSubtasks(await this.documents.latestBody(parent.key, SUBTASKS_KIND)));
    for (const task of tasks) {
      const child = settled(task) ? null : await this.runs.findSubtask(parent, task.id);
      if (child && disagrees(task, child)) return true;
    }
    return false;
  }

  hasPass(key: string): Promise<boolean> {
    return this.wakes.hasPass(key);
  }

  passDue(parent: RunEntity): boolean {
    return this.wakes.passDue(parent);
  }

  private started(): SubtaskStarter {
    if (!this.starter) {
      throw new Error('subtasks cannot start: no starter is registered');
    }
    return this.starter;
  }
}
