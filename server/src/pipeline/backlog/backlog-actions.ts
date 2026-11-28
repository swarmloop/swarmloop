import { ConflictException, Injectable } from '@nestjs/common';
import type { BacklogView } from '../../contract/backlog';
import type {
  AddItemBody,
  AddRepositoryBody,
  AddRequirementsBody,
  AddTaskBody,
  ChangeTaskBody,
  CloseRequirementBody,
  CreateBacklogBody,
  MoveItemBody,
  ProposeMilestoneBody,
  RecordDecisionBody,
} from '../../contract/backlog-actions';
import { Clock } from '../../core/clock';
import { BacklogRepository } from '../../history/backlog.repository';
import {
  BacklogActionSupport,
  outcome,
  type Milestone,
  type Outcome,
  type PlannerContext,
} from './backlog-action-support';
import { BacklogQueries } from './backlog-queries';
import { BacklogRequirementActions } from './backlog-requirement-actions';
import { BacklogScopeActions } from './backlog-scope-actions';
import { BacklogTaskActions } from './backlog-task-actions';
import { checkText, checkTransition, checkWorkDone, nextMilestoneNumber, queueMilestones } from './backlog-rules';

/** The only writer of backlogs: it validates, writes in one transaction and records who did it and when. */
@Injectable()
export class BacklogActions {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly queries: BacklogQueries,
    private readonly clock: Clock,
    private readonly support: BacklogActionSupport,
    private readonly scope: BacklogScopeActions,
    private readonly taskActions: BacklogTaskActions,
    private readonly requirementActions: BacklogRequirementActions,
  ) {}

  createBacklog(actor: string | null, body: CreateBacklogBody): Promise<BacklogView> {
    return this.scope.createBacklog(actor, body);
  }

  async proposeMilestone<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    body: ProposeMilestoneBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const title = checkText(body.title, 'the title');
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    const number = nextMilestoneNumber(
      (await this.support.reads(context).milestones(backlog.id as number)).map((m) => m.number),
    );
    await this.support.write(context, async (writers) => {
      await writers.saveMilestone({
        backlogId: backlog.id as number,
        number,
        title,
        goal,
        status: 'proposed',
        createdAt: this.clock.iso(),
      });
      await this.support.record(
        writers,
        backlog.id as number,
        who,
        'propose milestone',
        { milestone: `M${number}` },
        context,
      );
    });
    return outcome(this.queries, name, context);
  }

  /** Accepting is the owner's and the planner's, and only when the milestone's work is done; the milestone queued behind this one starts in the same write. */
  async acceptMilestone<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    number: number,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const { who, backlog } = await this.support.owned(actor, name, context);
    const milestones = await this.support.reads(context).milestones(backlog.id as number);
    const milestone = this.support.milestone(milestones, number);
    checkTransition(milestone.status, 'accepted');
    const reads = this.support.reads(context);
    const own = <Row extends { milestoneId: number | null }>(rows: Row[]) =>
      rows.filter((row) => row.milestoneId === milestone.id);
    checkWorkDone(
      number,
      own(await reads.tasks(backlog.id as number)),
      own(await reads.requirements(backlog.id as number)),
    );
    const next = milestones.find((other) => other.queuedAfterId === milestone.id && other.status === 'queued');
    await this.support.write(context, async (writers) => {
      await writers.saveMilestone({ ...milestone, status: 'accepted' });
      if (next) await writers.saveMilestone({ ...next, status: 'active', queuedAfterId: null });
      await this.support.record(
        writers,
        backlog.id as number,
        who,
        'accept milestone',
        { milestone: `M${number}` },
        context,
      );
    });
    return outcome(this.queries, name, context);
  }

  /** Starts the milestone when none is active; while one is active it queues behind the end of the queue, by the rule Run backlog uses. */
  async runMilestone(actor: string | null, name: string, number: number): Promise<BacklogView> {
    const { who, backlog } = await this.support.owned(actor, name);
    const milestones = await this.backlogs.milestones(backlog.id as number);
    const milestone = this.support.milestone(milestones, number);
    checkTransition(milestone.status, 'active');
    await this.writeQueue(who, backlog.id as number, milestones, [milestone], 'run milestone', {
      milestone: `M${number}`,
    });
    return this.queries.view(name);
  }

  /** Queues every proposed milestone in number order: the first starts when none is active, the others wait behind it or behind the queue. */
  async runBacklog(actor: string | null, name: string): Promise<BacklogView> {
    const { who, backlog } = await this.support.owned(actor, name);
    const milestones = await this.backlogs.milestones(backlog.id as number);
    const proposed = milestones.filter((milestone) => milestone.status === 'proposed');
    if (proposed.length === 0) throw new ConflictException('the backlog has no proposed milestone to run');
    await this.writeQueue(who, backlog.id as number, milestones, proposed, 'run backlog', {
      milestones: String(proposed.length),
    });
    return this.queries.view(name);
  }

  /** The moves of the queue rule for `chosen`, written with the action that asked for them in one transaction. */
  private async writeQueue(
    who: string,
    backlogId: number,
    milestones: Milestone[],
    chosen: Milestone[],
    action: string,
    facts: Record<string, string>,
  ): Promise<void> {
    const queueable = (list: Milestone[]) => list.map((m) => ({ ...m, id: m.id as number }));
    const moves = queueMilestones(queueable(chosen), queueable(milestones));
    await this.backlogs.transaction(async (writers) => {
      for (const move of moves) {
        const milestone = milestones.find((other) => other.id === move.id) as Milestone;
        await writers.saveMilestone({ ...milestone, status: move.status, queuedAfterId: move.queuedAfterId });
      }
      await this.support.record(writers, backlogId, who, action, facts);
    });
  }

  addRequirements<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    number: number,
    body: AddRequirementsBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.requirementActions.addRequirements(actor, name, number, body, context);
  }

  pause<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.setPaused(actor, name, true, context);
  }

  unpause<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.setPaused(actor, name, false, context);
  }

  addRepository(actor: string | null, name: string, body: AddRepositoryBody): Promise<BacklogView> {
    return this.scope.addRepository(actor, name, body);
  }

  async recordDecision<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    body: RecordDecisionBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const text = checkText(body.text, 'the decision');
    await this.support.write(context, async (writers) => {
      await writers.addDecision({ backlogId: backlog.id as number, text, who, createdAt: this.clock.iso() });
      await this.support.record(writers, backlog.id as number, who, 'record decision', {}, context);
    });
    return outcome(this.queries, name, context);
  }

  closeRequirement<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    ref: string,
    body: CloseRequirementBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.requirementActions.closeRequirement(actor, name, ref, body, context);
  }

  addTasks<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    body: AddTaskBody[],
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.taskActions.addTasks(actor, name, body, context);
  }

  changeTask<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    body: ChangeTaskBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.taskActions.changeTask(actor, name, slug, body, context);
  }

  deleteTask<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    context?: Context,
    expectedRevision?: number,
  ): Promise<Outcome<Context>> {
    return this.taskActions.deleteTask(actor, name, slug, context, expectedRevision);
  }

  skipTask<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.taskActions.skipTask(actor, name, slug, context);
  }

  mergeTask(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.taskActions.mergeTask(actor, name, slug);
  }

  runTaskNow(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.taskActions.runTaskNow(actor, name, slug);
  }

  dropItem<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.taskActions.dropItem(actor, name, slug, context);
  }

  addItem<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    body: AddItemBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.taskActions.addItem(actor, name, body, context);
  }

  moveItem<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    body: MoveItemBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.taskActions.moveItem(actor, name, slug, body, context);
  }

  private async setPaused<Context extends PlannerContext | undefined>(
    actor: string | null,
    name: string,
    paused: boolean,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    await this.support.write(context, async (writers) => {
      await writers.saveBacklog({ ...backlog, paused });
      await this.support.record(writers, backlog.id as number, who, paused ? 'pause' : 'unpause', {}, context);
    });
    return outcome(this.queries, name, context);
  }
}
