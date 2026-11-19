import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
import { listGitProjects } from '../../config/checkout-path';
import { AppConfig } from '../../config/env';
import { SwarmloopError } from '../../core/swarmloop-error';
import { Clock } from '../../core/clock';
import { BacklogRepository } from '../../history/backlog.repository';
import { root } from '../../history/run-paths';
import {
  BacklogActionSupport,
  outcome,
  type Milestone,
  type Outcome,
  type PlannerContext,
} from './backlog-action-support';
import { BacklogQueries } from './backlog-queries';
import { BacklogTaskActions } from './backlog-task-actions';
import {
  checkBacklogName,
  checkMergeMode,
  checkRepositories,
  checkText,
  checkTransition,
  nextMilestoneNumber,
  nextRequirementRefs,
  queueBacklog,
} from './backlog-rules';

/** The only writer of backlogs: it validates, writes in one transaction and records who did it and when. */
@Injectable()
export class BacklogActions {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly queries: BacklogQueries,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly support: BacklogActionSupport,
    private readonly taskActions: BacklogTaskActions,
  ) {}

  async createBacklog(actor: string | null, body: CreateBacklogBody): Promise<BacklogView> {
    const who = this.support.person(actor);
    const name = checkBacklogName(body.name);
    const repositories = checkRepositories(body.repositories, this.checkouts());
    const mergeMode = checkMergeMode(body.mergeMode);
    if ((await this.backlogs.findBacklog(name)) !== null) throw new ConflictException(`backlog ${name} exists`);
    await this.backlogs.transaction(async (writers) => {
      const saved = await writers.saveBacklog({
        name,
        owner: who,
        repositories,
        mergeMode,
        paused: false,
        createdAt: this.clock.iso(),
      });
      await this.support.record(writers, saved.id as number, who, 'create backlog', {
        repositories: repositories.join(', '),
      });
    });
    return this.queries.view(name);
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

  /** Accepting is the owner's; the milestone queued behind this one starts in the same write. */
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

  async runMilestone(actor: string | null, name: string, number: number): Promise<BacklogView> {
    const { who, backlog } = await this.support.owned(actor, name);
    const milestone = this.support.milestone(await this.backlogs.milestones(backlog.id as number), number);
    checkTransition(milestone.status, 'active');
    await this.backlogs.transaction(async (writers) => {
      await writers.saveMilestone({ ...milestone, status: 'active', queuedAfterId: null });
      await this.support.record(writers, backlog.id as number, who, 'run milestone', { milestone: `M${number}` });
    });
    return this.queries.view(name);
  }

  /** Starts the first proposed milestone and queues the other proposed ones behind it, in number order. */
  async runBacklog(actor: string | null, name: string): Promise<BacklogView> {
    const { who, backlog } = await this.support.owned(actor, name);
    const milestones = await this.backlogs.milestones(backlog.id as number);
    const first = milestones.find((milestone) => milestone.status === 'proposed');
    if (first === undefined) throw new ConflictException('the backlog has no proposed milestone to run');
    const queueable = milestones.map(({ id, number, status }) => ({ id: id as number, number, status }));
    const moves = queueBacklog(queueable[milestones.indexOf(first)], queueable);
    await this.backlogs.transaction(async (writers) => {
      for (const move of moves) {
        const milestone = milestones.find((other) => other.id === move.id) as Milestone;
        await writers.saveMilestone({ ...milestone, status: move.status, queuedAfterId: move.queuedAfterId });
      }
      await this.support.record(writers, backlog.id as number, who, 'run backlog', {
        milestones: String(moves.length),
      });
    });
    return this.queries.view(name);
  }

  async addRequirements<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    number: number,
    body: AddRequirementsBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const reads = this.support.reads(context);
    const milestone = this.support.milestone(await reads.milestones(backlog.id as number), number);
    if (!Array.isArray(body.texts) || body.texts.length === 0) throw new BadRequestException('no requirement given');
    const texts = body.texts.map((text) => checkText(text, 'a requirement'));
    const taken = (await reads.requirements(backlog.id as number)).map((requirement) => requirement.ref);
    const refs = nextRequirementRefs(number, taken, texts.length);
    await this.support.write(context, async (writers) => {
      for (const [index, text] of texts.entries()) {
        await writers.saveRequirement({ milestoneId: milestone.id as number, ref: refs[index], text, status: 'open' });
      }
      await this.support.record(
        writers,
        backlog.id as number,
        who,
        'add requirements',
        { requirements: refs.join(', ') },
        context,
      );
    });
    return outcome(this.queries, name, context);
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

  async addRepository(actor: string | null, name: string, body: AddRepositoryBody): Promise<BacklogView> {
    const { who, backlog } = await this.support.owned(actor, name);
    const [repository] = checkRepositories([body.repository], this.checkouts());
    if (backlog.repositories.includes(repository)) throw new ConflictException(`${repository} is already in scope`);
    await this.backlogs.transaction(async (writers) => {
      await writers.saveBacklog({ ...backlog, repositories: [...backlog.repositories, repository] });
      await this.support.record(writers, backlog.id as number, who, 'add repository', { repository });
    });
    return this.queries.view(name);
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

  /** Closing is the owner's: an open requirement is closed by hand, with what shows it is met. */
  async closeRequirement<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    ref: string,
    body: CloseRequirementBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const { who, backlog } = await this.support.owned(actor, name, context);
    const evidence = checkText(body.evidence, 'the evidence');
    const requirement = (await this.support.reads(context).requirements(backlog.id as number)).find(
      (other) => other.ref === ref,
    );
    if (requirement === undefined) throw new NotFoundException(`no requirement ${ref}`);
    if (requirement.status === 'closed') throw new ConflictException(`${ref} is already closed`);
    await this.support.write(context, async (writers) => {
      await writers.saveRequirement({ ...requirement, status: 'closed' });
      await this.support.record(
        writers,
        backlog.id as number,
        who,
        'close requirement',
        { requirement: ref, evidence },
        context,
      );
    });
    return outcome(this.queries, name, context);
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
  ): Promise<Outcome<Context>> {
    return this.taskActions.deleteTask(actor, name, slug, context);
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

  private checkouts(): string[] {
    const { CHECKOUTS_ROOT, SWARMLOOP_REPOS } = this.config.env;
    try {
      return listGitProjects(root(this.config), CHECKOUTS_ROOT, SWARMLOOP_REPOS);
    } catch (error) {
      if (error instanceof SwarmloopError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
