import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { subtaskKey } from '../core/pipeline-result';
import { phaseNames } from './run-input';
import { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { PipelineService } from '../pipeline/pipeline.service';
import { parseSubtasks, SUBTASKS_KIND, type Subtask } from '../contract/subtask';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { PlanChatStore } from '../history/plan-chat.store';
import { skipRun } from '../pipeline/skip-run';
import { SubtaskPort } from '../pipeline/subtask-port';
import { asksAtImplement } from '../steps/shared/epic-between-passes';
import { storedProjects } from '../config/checkout-path';
import { SKIPPED_NOTE } from '../contract/run-state';
import { RunRef } from '../contract/api';
import { subtaskPromptOf } from './subtask-prompt';
import { requireRun } from './run-queries.service';
import { RunCommandsService, type StartPlan } from './run-commands.service';

/** The commands of a parent run that make, start and close the runs of its tasks. */
@Injectable()
export class RunSubtaskCommandsService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly flows: FlowRepository,
    private readonly pipeline: PipelineService,
    private readonly subtasks: SubtaskPort,
    private readonly commands: RunCommandsService,
    private readonly chat: PlanChatStore,
  ) {}

  private async subtaskPlan(parent: RunEntity, task: Subtask): Promise<StartPlan> {
    return this.commands.plan({
      key: subtaskKey(parent.key, task.id),
      prompt: await this.promptOf(parent, task),
      projects: storedProjects(parent.projects),
    });
  }

  private async promptOf(parent: RunEntity, task: Subtask): Promise<string> {
    return subtaskPromptOf(this.documents, parent, task);
  }

  /** Starts one task of a parent run as a run of its own. A second call for the same task returns that run. */
  async startSubtask(parent: RunEntity, task: Subtask): Promise<RunRef> {
    const existing = await this.runs.findSubtask(parent, task.id);
    if (existing) {
      return { key: existing.key, status: existing.status === 'done' ? 'done' : 'started' };
    }
    const plan = await this.subtaskPlan(parent, task);
    const link = { parentRunId: parent.id, taskId: task.id, startedBy: parent.startedBy, agents: parent.agents };
    return this.commands.startPlanned({ ...plan, split: false, ...link });
  }

  /** The waiting run of a task. It is listed under the parent, but has no worktree until `launchSubtask`. */
  async openSubtask(parent: RunEntity, task: Subtask): Promise<RunEntity> {
    const existing = await this.runs.findSubtask(parent, task.id);
    if (existing) {
      return existing;
    }
    const plan = await this.subtaskPlan(parent, task);
    const run = await this.runs.openSubtask(plan.key, parent.id, task.id, parent.startedBy, parent.agents);
    await this.flows.noteFlow(plan.key, plan.phases, null);
    return run;
  }

  /** Starts the run that `openSubtask` made. A run that has started stays as it is. */
  async launchSubtask(parent: RunEntity, task: Subtask): Promise<void> {
    const run = await this.runs.findSubtask(parent, task.id);
    if (!run || run.status !== 'waiting' || run.currentStep !== 'requirements' || this.runs.held(run)) {
      return;
    }
    const prompt = await this.promptOf(parent, task);
    const result = await this.pipeline.startDetached(run.key, {
      prompt,
      projects: storedProjects(parent.projects),
      phases: phaseNames(),
      startBy: 'machine',
    });
    if (!result.message.includes('already running')) {
      this.commands.demandStart(result);
    }
  }

  /** Stops the run of a skipped task, closes its questions and ends it for good. `blocked` keeps a restart from relaunching it. */
  private async close(child: RunEntity): Promise<void> {
    await skipRun(
      { runs: this.runs, documents: this.documents, chat: this.chat },
      (run) => this.subtasks.stop(run),
      child,
      SKIPPED_NOTE,
    );
  }

  /** Marks a task skipped: its dependents treat it as merged. A running subtask of the task is stopped. */
  async skipTask(key: string, taskId: string): Promise<RunRef> {
    const parent = await requireRun(this.runs, key);
    if (this.runs.held(parent)) {
      throw new ConflictException(`${key} is already running`);
    }
    const tasks = parseSubtasks(await this.documents.latestBody(key, SUBTASKS_KIND));
    const task = tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new BadRequestException(`${taskId} is not a task of ${key}`);
    }
    const child = await this.runs.findSubtask(parent, taskId);
    if (child) {
      await this.close(child);
      await this.subtasks.closeMergeRequests(parent, child);
    }
    await this.documents.putDocument(
      parent,
      SUBTASKS_KIND,
      ARTIFACTS.subtasks.format(
        tasks.map((item) => (item === task ? { ...task, status: 'skipped', note: undefined } : item)),
      ),
    );
    const fresh = (await this.runs.findRun(key)) ?? parent;
    // An epic that waits on questions may wait on this part's, which the skip just closed: its pass is due as well.
    if (this.subtasks.passDue(fresh) || asksAtImplement(fresh))
      await this.subtasks.resumeParent(fresh, `skip-${taskId}-${fresh.revision}`);
    return { key, status: 'started' };
  }
}
