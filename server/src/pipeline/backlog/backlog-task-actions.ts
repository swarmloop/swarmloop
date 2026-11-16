import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { BacklogView } from '../../contract/backlog';
import type { AddItemBody, AddTaskBody, ChangeTaskBody, MoveItemBody } from '../../contract/backlog-actions';
import type { Subtask } from '../../contract/subtask';
import { Clock } from '../../core/clock';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { RunRepository } from '../../history/run.repository';
import { deriveState } from '../../history/run-state';
import { chainSharedFiles } from '../../steps/plan/plan-tasks';
import { CommandService } from '../command.service';
import { BacklogActionSupport, type Backlog, type Milestone } from './backlog-action-support';
import { BacklogQueries } from './backlog-queries';
import { checkText } from './backlog-rules';
import {
  checkNewSlugs,
  checkNotSettled,
  checkNotStartedForChange,
  checkNotStartedForDelete,
  checkRunnable,
  checkTasks,
  isStarted,
  type TaskScope,
} from './task-rules';

/** A run in one of these states has nothing left to stop. */
const ENDED = ['done', 'merged', 'skipped', 'closed'];

/** The actions on the tasks and the backlog items of a backlog; BacklogActions is the door to them. */
@Injectable()
export class BacklogTaskActions {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly queries: BacklogQueries,
    private readonly runs: RunRepository,
    private readonly commands: CommandService,
    private readonly clock: Clock,
    private readonly support: BacklogActionSupport,
  ) {}

  /** Tasks added together go to the end of the plan order; the ones that share a file are chained. */
  async addTasks(actor: string | null, name: string, body: AddTaskBody[]): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    if (!Array.isArray(body) || body.length === 0) throw new BadRequestException('no task given');
    const existing = await this.backlogs.tasks(backlog.id as number);
    const milestones = await this.backlogs.milestones(backlog.id as number);
    const slugs = checkNewSlugs(
      body.map((task) => task.id),
      existing.map((task) => task.slug),
    );
    const last = existing.reduce((top, task) => Math.max(top, task.position), 0);
    const added = body.map((task, index) => this.newTask(backlog, slugs[index], task, last + index + 1, milestones));
    checkTasks(added, await this.scope(backlog, existing));
    added.forEach(checkRunnable);
    this.chain(added);
    await this.backlogs.transaction(async (writers) => {
      for (const task of added) await writers.saveTask(task);
      await this.support.record(writers, backlog.id as number, who, 'add tasks', { tasks: slugs.join(', ') });
    });
    return this.queries.view(name);
  }

  async changeTask(actor: string | null, name: string, slug: string, body: ChangeTaskBody): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    const existing = await this.backlogs.tasks(backlog.id as number);
    const task = this.find(existing, slug);
    checkNotStartedForChange(task);
    checkNotSettled(task);
    const milestones = await this.backlogs.milestones(backlog.id as number);
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
    checkTasks(
      [changed],
      await this.scope(
        backlog,
        existing.filter((other) => other.slug !== slug),
      ),
    );
    checkRunnable(changed);
    await this.backlogs.transaction(async (writers) => {
      await writers.saveTask(changed);
      await this.support.record(writers, backlog.id as number, who, 'change task', { task: slug });
    });
    return this.queries.view(name);
  }

  deleteTask(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.remove(actor, name, slug, 'delete task');
  }

  /** A task with a run that has not ended is stopped first; then it is skipped. */
  async skipTask(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    const task = this.find(await this.backlogs.tasks(backlog.id as number), slug);
    checkNotSettled(task);
    const run = task.runKey === null ? null : await this.runs.findRun(task.runKey);
    if (task.runKey !== null && run !== null && !ENDED.includes(deriveState(run).state)) {
      await this.commands.submit('stop', task.runKey, {});
    }
    await this.backlogs.transaction(async (writers) => {
      await writers.saveTask({ ...task, status: 'skipped', note: '' });
      await this.support.record(writers, backlog.id as number, who, 'skip task', { task: slug });
    });
    return this.queries.view(name);
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
  async addItem(actor: string | null, name: string, body: AddItemBody): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    const existing = await this.backlogs.tasks(backlog.id as number);
    const [slug] = checkNewSlugs(
      [body.id],
      existing.map((task) => task.slug),
    );
    const last = existing.reduce((top, task) => Math.max(top, task.position), 0);
    const item = this.newTask(backlog, slug, { ...body, milestone: null }, last + 1, []);
    await this.backlogs.transaction(async (writers) => {
      await writers.saveTask(item);
      await this.support.record(writers, backlog.id as number, who, 'add item', { task: slug });
    });
    return this.queries.view(name);
  }

  async moveItem(actor: string | null, name: string, slug: string, body: MoveItemBody): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    const task = this.find(await this.backlogs.tasks(backlog.id as number), slug);
    checkNotStartedForChange(task);
    checkNotSettled(task);
    const milestoneId = this.milestoneId(await this.backlogs.milestones(backlog.id as number), body.milestone);
    checkRunnable({ ...task, milestoneId });
    await this.backlogs.transaction(async (writers) => {
      await writers.saveTask({ ...task, milestoneId });
      await this.support.record(writers, backlog.id as number, who, 'move item', {
        task: slug,
        milestone: `M${body.milestone}`,
      });
    });
    return this.queries.view(name);
  }

  dropItem(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.remove(actor, name, slug, 'drop item');
  }

  private async remove(actor: string | null, name: string, slug: string, action: string): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    const task = this.find(await this.backlogs.tasks(backlog.id as number), slug);
    checkNotStartedForDelete(task);
    await this.backlogs.transaction(async (writers) => {
      await writers.deleteTask(task.id as number);
      await this.support.record(writers, backlog.id as number, who, action, { task: slug });
    });
    return this.queries.view(name);
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

  private async scope(backlog: Backlog, others: BacklogTaskRecord[]): Promise<TaskScope> {
    const requirements = await this.backlogs.requirements(backlog.id as number);
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

  /** Chains the tasks that share a file within the batch, and copies the added dependencies onto them. */
  private chain(added: BacklogTaskRecord[]): void {
    const inBatch = new Set(added.map((task) => task.slug));
    const copies: Subtask[] = added.map((task) => ({
      id: task.slug,
      title: task.title,
      description: task.description,
      depends: task.depends.filter((id) => inBatch.has(id)),
      files: task.files,
      proof: '',
      status: 'pending',
    }));
    const kept = copies.map((copy) => copy.depends.length);
    chainSharedFiles(copies);
    copies.forEach((copy, index) => {
      added[index].depends = [...added[index].depends, ...copy.depends.slice(kept[index])];
    });
  }
}
