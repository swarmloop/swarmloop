import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { BacklogView } from '../../contract/backlog';
import type { AddItemBody, AddTaskBody, ChangeTaskBody, MoveItemBody } from '../../contract/backlog-actions';
import { Clock } from '../../core/clock';
import type { BacklogWriters } from '../../history/backlog-writers';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import {
  BacklogActionSupport,
  outcome,
  type Backlog,
  type Milestone,
  type Outcome,
  type PlannerContext,
} from './backlog-action-support';
import { BacklogQueries } from './backlog-queries';
import { chainBacklog, saveEdges, type ChainedBacklog } from './backlog-file-chain';
import { checkText } from './backlog-rules';
import { claimOrRefuse } from './task-claim';
import { TaskRunSkip } from './task-run-skip';
import {
  checkNewSlugs,
  checkNotSettled,
  checkNotStartedForChange,
  checkFiles,
  checkNotStartedForDelete,
  checkRunnable,
  checkTasks,
  isStarted,
  type TaskScope,
} from './task-rules';

/** The actions on the tasks and the backlog items of a backlog; BacklogActions is the door to them. */
@Injectable()
export class BacklogTaskActions {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly queries: BacklogQueries,
    private readonly taskRun: TaskRunSkip,
    private readonly clock: Clock,
    private readonly support: BacklogActionSupport,
  ) {}

  /** Tasks added together go to the end of the plan order; every task that shares a file with another is chained. */
  async addTasks<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    body: AddTaskBody[],
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const reads = this.support.reads(context);
    if (!Array.isArray(body) || body.length === 0) throw new BadRequestException('no task given');
    const existing = await reads.tasks(backlog.id as number);
    const milestones = await reads.milestones(backlog.id as number);
    const slugs = checkNewSlugs(
      body.map((task) => task.id),
      existing.map((task) => task.slug),
    );
    const last = existing.reduce((top, task) => Math.max(top, task.position), 0);
    const added = body.map((task, index) => this.newTask(backlog, slugs[index], task, last + index + 1, milestones));
    if (context) this.fixesFirst(added, existing);
    added.forEach(checkFiles);
    added.forEach(checkRunnable);
    const { chained, mine } = await this.chainChecked(backlog, existing, added, reads);
    await this.support.write(context, async (writers) => {
      for (const task of mine) await writers.saveTask(task);
      await this.writeEdges(writers, backlog, chained, mine, who);
      await this.support.record(writers, backlog.id as number, who, 'add tasks', { tasks: slugs.join(', ') }, context);
    });
    return outcome(this.queries, name, context);
  }

  async changeTask<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    body: ChangeTaskBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const reads = this.support.reads(context);
    const existing = await reads.tasks(backlog.id as number);
    const task = this.find(existing, slug);
    checkNotStartedForChange(task);
    checkNotSettled(task);
    const milestones = await reads.milestones(backlog.id as number);
    const changed: BacklogTaskRecord = {
      ...task,
      title: body.title === undefined ? task.title : checkText(body.title, 'the title'),
      description: body.description === undefined ? task.description : checkText(body.description, 'the description'),
      repositories: body.repositories ?? task.repositories,
      covers: body.covers ?? task.covers,
      depends: body.depends ?? task.depends,
      files: body.files ?? task.files,
      proof: body.proof ?? task.proof,
      milestoneId: body.milestone === undefined ? task.milestoneId : this.milestoneId(milestones, body.milestone),
    };
    checkFiles(changed);
    checkRunnable(changed);
    const others = existing.filter((other) => other.slug !== slug);
    const { chained, mine } = await this.chainChecked(backlog, others, [changed], reads);
    await this.support.write(context, async (writers) => {
      await claimOrRefuse(writers, task, body.expectedRevision ?? task.revision ?? 0);
      await writers.saveTask(mine[0]);
      await this.writeEdges(writers, backlog, chained, mine, who);
      await this.support.record(writers, backlog.id as number, who, 'change task', { task: slug }, context);
    });
    return outcome(this.queries, name, context);
  }

  deleteTask<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    context?: Context,
    expectedRevision?: number,
  ): Promise<Outcome<Context>> {
    return this.remove(actor, name, slug, 'delete task', context, expectedRevision);
  }

  /** The run of a task that has not ended is skipped first; then the task is. In a planner's turn the run is left to the tick. */
  async skipTask<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const task = this.find(await this.support.reads(context).tasks(backlog.id as number), slug);
    checkNotSettled(task);
    // A planner's turn runs this inside its transaction, which the stop command cannot join: the task is saved
    // skipped and the backlog tick ends its run (TaskRunSkip.endSkipped).
    if (task.runKey !== null && context === undefined) await this.taskRun.end(task.runKey);
    await this.support.write(context, async (writers) => {
      await writers.saveTask({ ...task, status: 'skipped', note: '' });
      await this.support.record(writers, backlog.id as number, who, 'skip task', { task: slug }, context);
    });
    return outcome(this.queries, name, context);
  }

  /** The OK of a task that has started and waits for it. */
  async mergeTask(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    const { who, backlog } = await this.support.owned(actor, name);
    const task = this.find(await this.backlogs.tasks(backlog.id as number), slug);
    checkNotSettled(task);
    if (!isStarted(task) || task.mergeOk) throw new ConflictException(`${slug} is not waiting for your OK to merge`);
    await this.backlogs.transaction(async (writers) => {
      await writers.saveTask({ ...task, mergeOk: true });
      await this.support.record(writers, backlog.id as number, who, 'merge task', { task: slug });
    });
    return this.queries.view(name);
  }

  /** Run now is the owner's: a task outside an active milestone joins the scheduler at once. */
  async runTaskNow(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    const { who, backlog } = await this.support.owned(actor, name);
    const task = this.find(await this.backlogs.tasks(backlog.id as number), slug);
    checkNotStartedForChange(task);
    checkNotSettled(task);
    const milestone = (await this.backlogs.milestones(backlog.id as number)).find(({ id }) => id === task.milestoneId);
    if (milestone?.status === 'active')
      throw new ConflictException(`${slug} is in an active milestone: it starts there`);
    checkRunnable({ ...task, runNow: true });
    await this.backlogs.transaction(async (writers) => {
      await writers.saveTask({ ...task, runNow: true });
      await this.support.record(writers, backlog.id as number, who, 'run task now', { task: slug });
    });
    return this.queries.view(name);
  }

  /** A backlog item is a task with no milestone: a title and a description until it is planned. */
  async addItem<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    body: AddItemBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const existing = await this.support.reads(context).tasks(backlog.id as number);
    const [slug] = checkNewSlugs(
      [body.id],
      existing.map((task) => task.slug),
    );
    const last = existing.reduce((top, task) => Math.max(top, task.position), 0);
    const item = this.newTask(backlog, slug, { ...body, milestone: null }, last + 1, []);
    await this.support.write(context, async (writers) => {
      await writers.saveTask(item);
      await this.support.record(writers, backlog.id as number, who, 'add item', { task: slug }, context);
    });
    return outcome(this.queries, name, context);
  }

  async moveItem<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    body: MoveItemBody,
    context?: Context,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const reads = this.support.reads(context);
    const existing = await reads.tasks(backlog.id as number);
    const task = this.find(existing, slug);
    checkNotStartedForChange(task);
    checkNotSettled(task);
    const milestoneId = this.milestoneId(await reads.milestones(backlog.id as number), body.milestone);
    checkRunnable({ ...task, milestoneId });
    const others = existing.filter((other) => other.slug !== slug);
    const { chained, mine } = await this.chainChecked(backlog, others, [{ ...task, milestoneId }], reads);
    await this.support.write(context, async (writers) => {
      await claimOrRefuse(writers, task, task.revision ?? 0);
      await writers.saveTask(mine[0]);
      await this.writeEdges(writers, backlog, chained, mine, who);
      await this.support.record(
        writers,
        backlog.id as number,
        who,
        'move item',
        { task: slug, milestone: `M${body.milestone}` },
        context,
      );
    });
    return outcome(this.queries, name, context);
  }

  dropItem<Context extends PlannerContext | undefined = undefined>(
    actor: string | null,
    name: string,
    slug: string,
    context?: Context,
  ): Promise<Outcome<Context>> {
    return this.remove(actor, name, slug, 'drop item', context);
  }

  private async remove<Context extends PlannerContext | undefined>(
    actor: string | null,
    name: string,
    slug: string,
    action: string,
    context?: Context,
    expectedRevision?: number,
  ): Promise<Outcome<Context>> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name, context);
    const task = this.find(await this.support.reads(context).tasks(backlog.id as number), slug);
    checkNotStartedForDelete(task);
    await this.support.write(context, async (writers) => {
      await claimOrRefuse(writers, task, expectedRevision ?? task.revision ?? 0);
      await writers.deleteTask(task.id as number);
      await this.support.record(writers, backlog.id as number, who, action, { task: slug }, context);
    });
    return outcome(this.queries, name, context);
  }

  private find(tasks: BacklogTaskRecord[], slug: string): BacklogTaskRecord {
    const task = tasks.find((other) => other.slug === slug);
    if (task === undefined) throw new NotFoundException(`no task ${slug}`);
    return task;
  }

  /** The id of a milestone that still takes tasks, or null when none is given. */
  private milestoneId(milestones: Milestone[], number: number | null | undefined): number | null {
    if (number === null || number === undefined) return null;
    const milestone = this.support.milestone(milestones, number);
    if (milestone.status === 'accepted') throw new ConflictException(`M${number} is accepted`);
    return milestone.id as number;
  }

  private async scope(
    backlog: Backlog,
    others: BacklogTaskRecord[],
    reads: Pick<BacklogWriters, 'requirements'> = this.backlogs,
  ): Promise<TaskScope> {
    const requirements = await reads.requirements(backlog.id as number);
    return { repositories: backlog.repositories, refs: requirements.map(({ ref }) => ref), others };
  }

  private newTask(
    backlog: Backlog,
    slug: string,
    body: Partial<AddTaskBody>,
    position: number,
    milestones: Milestone[],
  ): BacklogTaskRecord {
    return {
      backlogId: backlog.id as number,
      milestoneId: this.milestoneId(milestones, body.milestone),
      slug,
      title: checkText(body.title, 'the title'),
      description: checkText(body.description, 'the description'),
      repositories: body.repositories ?? [],
      covers: body.covers ?? [],
      depends: body.depends ?? [],
      files: body.files ?? [],
      proof: body.proof ?? [],
      manual: body.manual ?? false,
      fixesMain: body.fixesMain ?? null,
      status: 'waiting',
      runKey: null,
      note: '',
      runNow: false,
      mergeOk: false,
      merged: {},
      madeBy: 'person',
      position,
      createdAt: this.clock.iso(),
    };
  }

  /** In the planner's hands, a task that fixes a red main goes before every task that is already planned. */
  private fixesFirst(added: BacklogTaskRecord[], existing: BacklogTaskRecord[]): void {
    const fixes = added.filter((task) => task.fixesMain !== null);
    const first = existing.reduce((low, task) => Math.min(low, task.position), 1);
    fixes.forEach((task, index) => {
      task.position = first - fixes.length + index;
    });
  }

  /**
   * The own tasks checked, then chained with every other task of the backlog by their files, then checked again with
   * the chained others, so an edge that closes a cycle through a requirement refuses the action.
   */
  private async chainChecked(
    backlog: Backlog,
    others: BacklogTaskRecord[],
    own: BacklogTaskRecord[],
    reads: Pick<BacklogWriters, 'requirements' | 'milestones'>,
  ): Promise<{ chained: ChainedBacklog; mine: BacklogTaskRecord[] }> {
    const scope = await this.scope(backlog, others, reads);
    checkTasks(own, scope);
    const chained = chainBacklog([...others, ...own], await reads.milestones(backlog.id as number));
    const mine = chained.tasks.slice(others.length);
    checkTasks(mine, { ...scope, others: chained.tasks.slice(0, others.length) });
    return { chained, mine };
  }

  private writeEdges(
    writers: BacklogWriters,
    backlog: Backlog,
    chained: ChainedBacklog,
    mine: BacklogTaskRecord[],
    who: string,
  ): Promise<void> {
    const edit = { backlogId: backlog.id as number, who, at: this.clock.iso() };
    return saveEdges(writers, chained, new Set(mine.map((task) => task.slug)), edit);
  }
}
