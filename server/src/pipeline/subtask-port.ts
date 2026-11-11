import { existsSync } from 'fs';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { agentFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { resumableChat } from '../agent/agent-session';
import { visitStatus } from '../core/pipeline-result';
import { SwarmloopError } from '../core/swarmloop-error';
import { Clock } from '../core/clock';
import { fetchBranch } from '../git/rebase';
import { originRef } from '../git/base-ref';
import { git } from '../git/git';
import { mountsForStep, repoNames, worktreePath } from '../git/repo-names';
import { root } from '../history/run-paths';
import { parseMergeRequests } from '../steps/merge-request/merge-request-record';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { ERROR_CODES, SUBTASK_WAIT_CODES } from '../contract/error-codes';
import { isSubtask, parseSubtasks, settled, SUBTASKS_KIND, type Subtask } from '../contract/subtask';
import { SubtaskOps, type SubtaskMergeRequest } from '../steps/shared/subtask-ops';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import type { AgentRunResult } from '../agent/agent-runner';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { agentFailure } from '../steps/shared/agent-result';
import { unanswered } from '../steps/shared/answers';
import { items } from '../steps/shared/markdown-section';
import { modelVisit } from '../steps/shared/model-visit';
import { StepStopped } from '../steps/shared/step-stopped';
import { DECIDE_YOURSELF, subtaskAsks } from '../steps/plan/plan.prompts';
import type { OpenedStep } from '../steps/step-run';
import { CommandService } from './command.service';

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

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly launcher: AgentLauncher,
    private readonly visits: VisitRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    super();
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
      : await this.plannerAnswer(opened, task, questions, contract);
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
  private async plannerAnswer(
    opened: OpenedStep,
    task: Subtask,
    questions: string,
    contract: string,
  ): Promise<string | null> {
    const parent = opened.run;
    const env = this.config.env;
    const { runtime, model } = agentFor(env, null, 'plan');
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

  override async fastForward(parent: RunEntity): Promise<void> {
    const branch = await this.branchOf(parent);
    const names = repoNames((await this.documents.latestBody(parent.key, ARTIFACTS.repos.kind)) ?? '');
    for (const repo of names) {
      const path = worktreePath(root(this.config), parent.key, repo);
      if (existsSync(path) && (await fetchBranch(path, repo, branch, { ...this.config.env, clock: this.clock }))) {
        await git(['-C', path, 'merge', '--ff-only', originRef(branch)]);
      }
    }
  }

  override async rebase(run: RunEntity): Promise<void> {
    if (!['failed', 'done', 'waiting'].includes(run.status) || (await this.mergeRequests(run)).length === 0) return;
    try {
      await this.commands.accept(
        'rebase',
        run.key,
        {},
        { idempotencyKey: `subtask-rebase-${run.revision}-${run.generation}` },
      );
    } catch (error) {
      this.logger.warn(`${run.key} was not rebased: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  async notifyParent(key: string): Promise<void> {
    try {
      const run = await this.runs.findRun(key);
      const parent = run && isSubtask(run) ? await this.runs.findById(run.parentRunId as number) : null;
      if (run && parent && this.passDue(parent)) {
        await this.resumeParent(parent, `subtask-${run.key}-${run.revision}`);
      }
    } catch (error) {
      this.logger.warn(`parent of ${key} was not told: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Sends `resume` to a parent that waits between passes. A pass that already runs, or is queued, is enough. */
  async resumeParent(parent: RunEntity, idempotencyKey: string): Promise<void> {
    await this.commands.accept('resume', parent.key, {}, { idempotencyKey });
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
