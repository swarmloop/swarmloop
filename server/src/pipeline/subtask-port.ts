import { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { join } from 'path';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { agentFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { resumableChat } from '../agent/agent-session';
import { visitStatus } from '../core/pipeline-result';
import { SwarmloopError } from '../core/swarmloop-error';
import { Clock } from '../core/clock';
import { mountsForStep, repoNames } from '../git/repo-names';
import { root } from '../history/run-paths';
import { parseMergeRequests } from '../steps/merge-request/merge-request-record';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../contract/error-codes';
import { isSubtask, parseSubtasks, settled, SUBTASKS_KIND, type Subtask } from '../contract/subtask';
import { SubtaskOps, type RebaseEvent, type SubtaskMergeRequest } from '../steps/shared/subtask-ops';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import type { AgentRunResult } from '../agent/agent-runner';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { agentFailure } from '../steps/shared/agent-result';
import { unanswered } from '../steps/shared/answers';
import { items } from '../steps/shared/markdown-section';
import { parseNeeds, type Need } from '../steps/shared/needs';
import { mergeHandoff } from '../steps/shared/handoff';
import { mergeSummaryOf } from './merge-summary';
import { modelVisit } from '../steps/shared/model-visit';
import { StepStopped } from '../steps/shared/step-stopped';
import { DECIDE_YOURSELF, subtaskAsks } from '../steps/plan/plan.prompts';
import type { OpenedStep } from '../steps/step-run';
import { DELIVERED_PREFIX } from '../steps/commit/commit-result';
import { RunRebase } from '../steps/run-rebase';
import { CommandService } from './command.service';
import { SubtaskWorktrees } from './subtask-worktrees';

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
  /** The planner's reply per subtask run whose delivery was refused, so a retry sends it again and does not ask again. */
  private readonly undelivered = new Map<string, string | null>();
  private starter: SubtaskStarter | null = null;
  private readonly worktrees: SubtaskWorktrees;

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly launcher: AgentLauncher,
    private readonly visits: VisitRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    @Optional() publisher?: RebasedPublisher,
    @Optional() private readonly rebaser?: RunRebase,
  ) {
    super();
    this.worktrees = new SubtaskWorktrees(config, clock, publisher);
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
    if (run.status !== 'waiting' || JSON.stringify(deriveState(run).reason) === JSON.stringify(reason)) return;
    writeRunState(run, { status: 'waiting', reason });
    await this.runs.saveRun(run);
  }

  override async asking(run: RunEntity): Promise<boolean> {
    if (run.status !== 'waiting' || run.currentStep !== 'research') return false;
    const questions = (await this.documents.latestBody(run.key, ARTIFACTS.questions.kind)) ?? '';
    const answers = (await this.documents.latestBody(run.key, ARTIFACTS.answers.kind)) ?? '';
    return unanswered(questions, answers).length > 0;
  }

  override async answer(opened: OpenedStep, child: RunEntity, task: Subtask, contract: string): Promise<string | null> {
    const questions = (await this.documents.latestBody(child.key, ARTIFACTS.questions.kind)) ?? '';
    const answer = this.undelivered.has(child.key)
      ? (this.undelivered.get(child.key) ?? null)
      : await this.askAbout(opened, task, questions, contract);
    const text = answer ?? DECIDE_YOURSELF;
    const answers = items(questions).map((id) => ({ kind: 'question', id, body: text }));
    try {
      await this.commands.submit(
        'answer',
        child.key,
        { answers },
        { idempotencyKey: `subtask-answer-${child.key}-${child.revision}` },
      );
    } catch (error) {
      this.undelivered.set(child.key, answer);
      this.logger.warn(`${child.key} was not answered: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.undelivered.delete(child.key);
    return answer;
  }

  /**
   * A follow-up visit of the plan step in the chat of the parent, recorded like any visit of that step. The pass
   * already holds the parent, so nothing else uses the chat meanwhile. Null when the planner gave no usable answer.
   */
  override async askAbout(
    opened: OpenedStep,
    task: Subtask,
    questions: string,
    contract: string,
  ): Promise<string | null> {
    const parent = opened.run;
    const env = this.config.env;
    const { runtime, model, ...effort } = agentFor(env, parent, 'plan');
    const dir = root(this.config);
    if (!(await resumableChat(dir, parent.key, 'plan', runtime))?.chatId) return null;
    const prompt = subtaskAsks(task, questions, contract);
    let result: AgentRunResult | null = null;
    let failure: string | null = null;
    try {
      const names = repoNames((await this.documents.latestBody(parent.key, ARTIFACTS.repos.kind)) ?? '');
      result = await this.launcher.launch({
        root: dir,
        run: parent,
        key: parent.key,
        step: 'plan',
        mode: 'plan',
        tools: 'plan',
        runtime,
        model,
        ...effort,
        timeLimitMs: env.PLAN_TIMEOUT_MS,
        prompt,
        workspace: join(dir, 'worktrees', parent.key),
        mounts: mountsForStep(dir, parent.key, names, parent.targetPath),
      });
      failure = agentFailure(result, 'plan', 'plan');
    } catch (error) {
      if (error instanceof StepStopped) throw error;
      failure = error instanceof SwarmloopError ? error.message : 'plan failed';
    }
    const answer = failure ? '' : (result?.responseText ?? '').trim();
    await this.visits.finishVisit(
      parent,
      modelVisit({
        opened,
        now: this.clock.now(),
        step: 'plan',
        mode: 'plan',
        runtime,
        model,
        ...effort,
        agent: result,
        prompt,
        status: visitStatus(answer ? 'ok' : 'failed'),
        exitCode: answer ? 0 : 1,
      }),
    );
    return answer || null;
  }

  override async withoutCi(run: RunEntity): Promise<boolean> {
    return ((await this.documents.latestBody(run.key, 'pipeline_log')) ?? '').startsWith('result: none');
  }

  override async deliveredNote(run: RunEntity): Promise<string | null> {
    const body = ((await this.documents.latestBody(run.key, ARTIFACTS.commit.kind)) ?? '').trim();
    return body.startsWith(DELIVERED_PREFIX) ? body : null;
  }

  override async needsOf(run: RunEntity): Promise<Need[]> {
    return parseNeeds((await this.documents.latestBody(run.key, ARTIFACTS.needs.kind)) ?? '');
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

  override async rerun(run: RunEntity, lines: string[]): Promise<void> {
    const needs = await this.documents.latestBody(run.key, ARTIFACTS.needs.kind);
    const handoff = await this.documents.latestBody(run.key, ARTIFACTS.handoff.kind);
    await this.documents.putDocument(run, ARTIFACTS.needs.kind, '');
    await this.documents.putDocument(
      run,
      ARTIFACTS.handoff.kind,
      mergeHandoff(handoff, run.currentStep, lines.join('\n')),
    );
    try {
      await this.commands.accept(
        'resume',
        run.key,
        {},
        { idempotencyKey: `subtask-needs-${run.key}-${(await this.visits.listStats(run.id)).length}` },
      );
    } catch (error) {
      await this.documents.putDocument(run, ARTIFACTS.needs.kind, needs ?? '');
      throw error;
    }
  }

  override async resume(run: RunEntity): Promise<void> {
    await this.commands.accept('resume', run.key, {}, { idempotencyKey: `subtasks-resume-${run.revision}` });
  }

  override async mergeRequests(run: RunEntity): Promise<SubtaskMergeRequest[]> {
    const body = await this.documents.latestBody(run.key, ARTIFACTS.mergeRequest.kind);
    if (!body?.trim()) return [];
    const names = repoNames((await this.documents.latestBody(run.key, ARTIFACTS.repos.kind)) ?? '');
    return parseMergeRequests(body).map((record, index) => ({
      repo: names[index] ?? record.project,
      project: record.project,
      iid: record.iid,
    }));
  }

  override async branchOf(run: RunEntity): Promise<string> {
    const requirements = (await this.documents.latestBody(run.key, ARTIFACTS.requirements.kind)) ?? '';
    return branchName(run.key, summaryForBranch(requirements, run.key));
  }

  override async recordMerged(parent: RunEntity, run: RunEntity, merged: Record<string, string>): Promise<void> {
    await this.recordMergedFiles(parent, run, merged);
    try {
      const fresh = await this.runs.findById(run.id);
      if (fresh?.status !== 'done' || fresh.mergeOutcome) return;
      const at = this.clock.iso();
      const facts = Object.fromEntries(
        Object.entries(merged).map(([repo, sha]) => [repo, { sha: sha || null, by: null, at, url: null }]),
      );
      await this.runs.release(fresh, { status: 'done', doneAt: fresh.doneAt ?? at, merge: { merged: facts } });
    } catch (error) {
      this.logger.warn(
        `The merge of ${run.key} was not recorded on its run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The files the merge of each repository changed, taken from its merge commit. A merge git cannot read leaves none. */
  private async recordMergedFiles(parent: RunEntity, run: RunEntity, merged: Record<string, string>): Promise<void> {
    try {
      const files = await this.worktrees.changedFiles(run, merged, await this.branchOf(parent));
      await this.documents.putDocument(run, ARTIFACTS.mergedFiles.kind, files.join('\n'));
    } catch (error) {
      this.logger.warn(
        `The files of the merge of ${run.key} were not read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  override async fastForward(parent: RunEntity): Promise<void> {
    await this.worktrees.fastForward(parent, await this.reposOf(parent), await this.branchOf(parent));
  }

  override async rebase(run: RunEntity, event?: RebaseEvent): Promise<boolean> {
    if (!(await this.canTakeRebase(run, !!event))) return false;
    if (deriveState(run).state === 'running') {
      if (event) await this.queueRebase(run, event.note);
      return !!event;
    }
    try {
      await this.sendRebase(run, event);
    } catch (error) {
      this.logger.warn(`${run.key} was not rebased: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (event) await this.noteRebase(run, event.note);
    return true;
  }

  /**
   * Sends the Rebase. The key names the event; when the command of that key died, the next try is a new event named
   * after the command that died, so a rebase that failed once is sent again and never the same one twice.
   */
  private async sendRebase(run: RunEntity, event?: RebaseEvent): Promise<void> {
    if (!event) {
      await this.commands.accept(
        'rebase',
        run.key,
        { byParent: true },
        { idempotencyKey: `subtask-rebase-${run.revision}-${run.generation}` },
      );
      return;
    }
    let idempotencyKey = `subtask-rebase-${run.key}-${event.tip}`;
    for (;;) {
      const sent = await this.commands.accept('rebase', run.key, { byParent: true }, { idempotencyKey });
      if (!sent.replayed || sent.command.state !== 'failed') return;
      idempotencyKey = `${idempotencyKey}-after-${sent.command.id}`;
    }
  }

  /** A run that waits for a person or a sibling is never resumed by a rebase, and a stopped one is a person's. */
  private async canTakeRebase(run: RunEntity, byEvent: boolean): Promise<boolean> {
    const { state, reason } = deriveState(run);
    const states = byEvent
      ? ['failed', 'done', 'waiting', 'idle', 'blocked', 'running']
      : ['failed', 'done', 'waiting', 'idle'];
    if (!states.includes(state)) return false;
    if (state === 'waiting' && (reason?.code === ERROR_CODES.SUBTASK_WAITING || (await this.asking(run)))) return false;
    return (await this.mergeRequests(run)).length > 0;
  }

  private async queueRebase(run: RunEntity, note: string): Promise<void> {
    if ((await this.documents.latestBody(run.key, ARTIFACTS.pendingRebase.kind)) !== note) {
      await this.documents.putDocument(run, ARTIFACTS.pendingRebase.kind, note);
    }
  }

  private async noteRebase(run: RunEntity, note: string): Promise<void> {
    const handoff = await this.documents.latestBody(run.key, ARTIFACTS.handoff.kind);
    await this.documents.putDocument(run, ARTIFACTS.handoff.kind, mergeHandoff(handoff, 'rebase', note));
  }

  /**
   * Takes the rebase a working subtask run was sent, now that its step has ended. Returns the step the run goes on
   * at, or null when nothing was waiting or the rebase was refused.
   */
  async applyPendingRebase(key: string): Promise<string | null> {
    const run = await this.runs.findRun(key);
    const note =
      run && isSubtask(run) ? (await this.documents.latestBody(key, ARTIFACTS.pendingRebase.kind))?.trim() : '';
    if (!run || !note) return null;
    await this.documents.putDocument(run, ARTIFACTS.pendingRebase.kind, '');
    try {
      await this.rebaser?.rebase(key, false, true);
    } catch (error) {
      this.logger.warn(`${key} was not rebased: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const moved = await this.runs.findRun(key);
    if (moved) await this.noteRebase(moved, note);
    return moved?.currentStep ?? null;
  }

  /** Sends a Rebase to every subtask of the parent that is not merged or skipped. */
  async rebaseOpen(parent: RunEntity): Promise<void> {
    const open = parseSubtasks(await this.documents.latestBody(parent.key, SUBTASKS_KIND)).filter(
      (task) => !settled(task),
    );
    for (const task of open) {
      const child = await this.runs.findSubtask(parent, task.id);
      if (child) await this.rebase(child);
    }
  }

  async stop(run: RunEntity): Promise<void> {
    await this.commands.submit('stop', run.key, {});
  }

  /** Stops every subtask of the parent. A subtask that is not running stays as it is. */
  async stopAll(parent: RunEntity): Promise<void> {
    for (const child of await this.runs.children(parent)) {
      if (deriveState(child).state === 'skipped') continue;
      await this.stop(child);
    }
  }

  /** Stops every subtask of the parent and removes its run and worktrees. */
  async removeAll(parent: RunEntity): Promise<void> {
    for (const child of await this.runs.children(parent)) {
      await this.commands.submit('remove', child.key, {});
    }
  }

  /** Sends the parent of a subtask a `resume`, so its next pass sees the subtask as it is now. */
  async notifyParent(key: string, idempotencyKey?: string): Promise<void> {
    try {
      const run = await this.runs.findRun(key);
      const parent = run && isSubtask(run) ? await this.runs.findById(run.parentRunId as number) : null;
      if (run && parent && this.passDue(parent)) {
        await this.resumeParent(parent, idempotencyKey ?? `subtask-${run.key}-${run.revision}`);
      }
    } catch (error) {
      this.logger.warn(`parent of ${key} was not told: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The key of the wake-up for a subtask that is `blocked` or `failed` and is about to leave that state; null for any other run. */
  async leavingKey(key: string): Promise<string | null> {
    const run = await this.runs.findRun(key);
    if (!run || !isSubtask(run) || !['blocked', 'failed'].includes(deriveState(run).state)) return null;
    return `subtask-left-${run.key}-${(await this.visits.listStats(run.id)).length}`;
  }

  /** Sends `resume` to a parent that waits between passes. A pass that already runs, or is queued, is enough. */
  async resumeParent(parent: RunEntity, idempotencyKey: string): Promise<void> {
    await this.commands.accept('resume', parent.key, {}, { idempotencyKey });
  }

  /** True when the subtasks are not as the last pass saw them, or when no pass recorded them yet. */
  async subtasksChanged(parent: RunEntity): Promise<boolean> {
    return (
      parent.subtaskFingerprint === null || parent.subtaskFingerprint !== (await this.runs.subtaskFingerprint(parent))
    );
  }

  /** A split parent in implement with subtask runs: a pass that already runs, or is queued, is enough for a resume. */
  async hasPass(key: string): Promise<boolean> {
    const run = await this.runs.findRun(key);
    return !!run?.split && run.currentStep === 'implement' && (await this.runs.children(run)).length > 0;
  }

  /** Between passes: the parent waits for its subtasks, or a blocked subtask stopped it. */
  passDue(parent: RunEntity): boolean {
    const { state, reason } = deriveState(parent);
    const code = reason?.code ?? '';
    return (
      parent.currentStep === 'implement' &&
      ((state === 'waiting' && SUBTASK_WAIT_CODES.some((wait) => wait === code)) ||
        (state === 'blocked' && code === ERROR_CODES.SUBTASK_BLOCKED))
    );
  }

  private started(): SubtaskStarter {
    if (!this.starter) {
      throw new Error('subtasks cannot start: no starter is registered');
    }
    return this.starter;
  }
}
