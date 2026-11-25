import { Injectable } from '@nestjs/common';
import type { AddTaskBody } from '../../../contract/backlog-actions';
import { settled } from '../../../contract/subtask';
import { isRunAction } from '../../../agent-result/definitions/backlog-turn';
import type { BacklogTurnAction, RunAction } from '../../../agent-result/definitions/backlog-turn';
import type { BacklogRecord, BacklogTaskRecord, BacklogWriters } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import { RunRepository } from '../../../history/run.repository';
import { stopReason } from './planner-run-state';

/** The newest events the rules read; a turn's own events and the last main-green are always among them. */
const EVENT_WINDOW = 1000;

/** What only the owner does: the planner is refused, and the reason says whose it is. */
const OWNER_ONLY: Record<string, string> = {
  runMilestone: 'only the owner runs a milestone: the person presses Run milestone under the proposal',
  runBacklog: 'only the owner runs the backlog: the person presses Run backlog under the proposal',
  runTask: 'only the owner runs a task',
  runTaskNow: 'only the owner runs a task now',
  addRepository: 'only the owner adds a repository to the backlog: ask the person in the chat to add it',
  mergeTask: 'only the owner gives the OK to merge a task',
};

/** An action as the rules see it: one the result may carry, or one that only the owner takes. */
export type JudgedAction = BacklogTurnAction | { action: keyof typeof OWNER_ONLY };

/** What the rules decide for an action: it goes on (the server may adjust it) or it is refused, with the reason in plain words. */
type Judgement = { action: BacklogTurnAction } | { refusal: string };

const refuse = (refusal: string): Judgement => ({ refusal });

/** The server's rules for the planner, read from the database; the model does not keep them. */
@Injectable()
export class PlannerRules {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
  ) {}

  async judge(reads: BacklogWriters, backlog: BacklogRecord, action: JudgedAction): Promise<Judgement> {
    if (action.action in OWNER_ONLY) return refuse(OWNER_ONLY[action.action]);
    const given = action as BacklogTurnAction;
    const tasks = await reads.tasks(backlog.id as number);
    return isRunAction(given)
      ? this.runAction(backlog, tasks, given)
      : this.backlogAction(reads, backlog, tasks, given);
  }

  /** A command to a run: the run is a task's run or lies below one, and a resume is not a repeat. */
  private async runAction(backlog: BacklogRecord, tasks: BacklogTaskRecord[], action: RunAction): Promise<Judgement> {
    const own = this.ownRun(tasks, action.run);
    if (own !== null && !(await this.belowTaskRun(tasks, action.run))) return refuse(own);
    if (action.action !== 'resume') return { action };
    return this.verdict(action, await this.repeatedResume(backlog, action.run));
  }

  private async backlogAction(
    reads: BacklogWriters,
    backlog: BacklogRecord,
    tasks: BacklogTaskRecord[],
    action: Exclude<BacklogTurnAction, RunAction>,
  ): Promise<Judgement> {
    switch (action.action) {
      case 'addTasks':
        return this.added(reads, backlog, tasks, action);
      case 'changeTask':
        return this.changed(reads, backlog, tasks, action);
      case 'deleteTask':
      case 'skipBacklogTask':
      case 'moveItem':
      case 'dropItem':
        return this.verdict(action, this.startedRefusal(tasks, action.task));
      case 'proposeMilestone':
      case 'acceptMilestone':
      case 'addRequirements':
      case 'recordDecision':
      case 'addItem':
      case 'pause':
      case 'unpause':
      case 'closeRequirement':
        return { action };
    }
  }

  private verdict(action: BacklogTurnAction, refusal: string | null): Judgement {
    return refusal === null ? { action } : refuse(refusal);
  }

  private async added(
    reads: BacklogWriters,
    backlog: BacklogRecord,
    tasks: BacklogTaskRecord[],
    action: Extract<BacklogTurnAction, { action: 'addTasks' }>,
  ): Promise<Judgement> {
    const active = (await reads.milestones(backlog.id as number)).find((milestone) => milestone.status === 'active');
    const requirements = await reads.requirements(backlog.id as number);
    const planned: AddTaskBody[] = [];
    for (const task of action.tasks) {
      const refusal =
        this.scopeRefusal(backlog, task.repositories ?? []) ??
        this.coverRefusal(tasks, requirements, task.covers ?? []) ??
        (await this.fixRefusal(backlog, tasks, planned, task));
      if (refusal) return refuse(refusal);
      const fixesWithoutMilestone = task.fixesMain && task.milestone === undefined;
      if (fixesWithoutMilestone && active === undefined) {
        return refuse(
          `${task.id} fixes a red main, but no milestone is active to put it in: ask the person in the chat`,
        );
      }
      planned.push(fixesWithoutMilestone ? { ...task, milestone: active?.number } : task);
    }
    return { action: { ...action, tasks: planned } };
  }

  private async changed(
    reads: BacklogWriters,
    backlog: BacklogRecord,
    tasks: BacklogTaskRecord[],
    action: Extract<BacklogTurnAction, { action: 'changeTask' }>,
  ): Promise<Judgement> {
    const requirements = await reads.requirements(backlog.id as number);
    const task = tasks.find((other) => other.slug === action.task);
    const newlyCovered = (action.covers ?? []).filter((ref) => !task?.covers.includes(ref));
    return this.verdict(
      action,
      this.startedRefusal(tasks, action.task) ??
        this.scopeRefusal(backlog, action.repositories ?? []) ??
        this.coverRefusal(tasks, requirements, newlyCovered),
    );
  }

  /** A task that names a repository outside the backlog is refused, and the planner asks the person to add it. */
  private scopeRefusal(backlog: BacklogRecord, repositories: string[]): string | null {
    const outside = repositories.find((repository) => !backlog.repositories.includes(repository));
    return outside === undefined
      ? null
      : `${outside} is not a repository of this backlog: ask the person in the chat to add it to the backlog`;
  }

  /** A task that has started takes no change from the planner: its own planner takes the message, or a new task goes in. */
  private startedRefusal(tasks: BacklogTaskRecord[], slug: string): string | null {
    const task = tasks.find((other) => other.slug === slug);
    return task?.runKey
      ? `${slug} has started: write to its run with planChat, or add a new task; skipTask or stop act on its run`
      : null;
  }

  /** A run the planner talks to is one of the runs of this backlog's tasks. */
  private ownRun(tasks: BacklogTaskRecord[], run: string): string | null {
    return tasks.some((task) => task.runKey === run) ? null : `${run} is not a run of this backlog`;
  }

  /** True when a run above `run` is the run of one of the tasks. */
  private async belowTaskRun(tasks: BacklogTaskRecord[], run: string): Promise<boolean> {
    let at = await this.runs.findRun(run);
    while (at && typeof at.parentRunId === 'number') {
      at = await this.runs.findById(at.parentRunId);
      if (at && tasks.some((task) => task.runKey === at?.key)) return true;
    }
    return false;
  }

  /** A resume of a run that is blocked again for the reason of its last planner resume goes to the person. */
  private async repeatedResume(backlog: BacklogRecord, run: string): Promise<string | null> {
    const reason = await stopReason(this.runs, run);
    if (reason === '') return null;
    const events = await this.backlogs.events(backlog.id as number, EVENT_WINDOW);
    const last = events.find((event) => event.facts.command === 'resume' && event.facts.run === run);
    return last?.facts.blockCode === reason
      ? `${run} is blocked again for the same reason as at the last resume: ask the person in the chat`
      : null;
  }

  /** A requirement that is still open after two covering tasks merged following its first one goes to the person. */
  private coverRefusal(
    tasks: BacklogTaskRecord[],
    requirements: { ref: string; status: string }[],
    refs: string[],
  ): string | null {
    for (const ref of refs) {
      if (requirements.find((requirement) => requirement.ref === ref)?.status === 'closed') continue;
      const covering = tasks.filter((task) => task.covers.includes(ref)).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      if (covering.slice(1).filter((task) => task.status === 'merged').length >= 2) {
        return `${ref} is still open after two more tasks merged: ask the person in the chat before another task`;
      }
    }
    return null;
  }

  /** One open task fixes the red main of a repository; a third after two merged on a main that is still red goes to the person. */
  private async fixRefusal(
    backlog: BacklogRecord,
    tasks: BacklogTaskRecord[],
    planned: AddTaskBody[],
    task: AddTaskBody,
  ): Promise<string | null> {
    const repository = task.fixesMain;
    if (!repository) return null;
    const fixes = tasks.filter((other) => other.fixesMain === repository);
    const open =
      fixes.filter((other) => !settled(other)).length + planned.filter((p) => p.fixesMain === repository).length;
    if (open > 0) return `a task already fixes the red main of ${repository}: ${task.id} waits for it`;
    const id = backlog.id as number;
    if ((await this.backlogs.latestMainEvent(id, repository)) !== 'main-red') return null;
    const events = await this.backlogs.events(id, EVENT_WINDOW);
    const green = events.find((event) => event.kind === 'main-green' && event.facts.repository === repository);
    const merged = fixes.filter((other) => other.status === 'merged' && (!green || other.createdAt > green.createdAt));
    return merged.length >= 2
      ? `two fixes of ${repository} merged and its main is still red: ask the person in the chat`
      : null;
  }
}
