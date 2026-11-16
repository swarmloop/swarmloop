import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { BacklogView } from '../../contract/backlog';
import type {
  AddItemBody,
  AddRepositoryBody,
  AddRequirementsBody,
  AddTaskBody,
  ChangeTaskBody,
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
import { BacklogActionSupport, type Milestone } from './backlog-action-support';
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

  async proposeMilestone(actor: string | null, name: string, body: ProposeMilestoneBody): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    const title = checkText(body.title, 'the title');
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    const number = nextMilestoneNumber((await this.backlogs.milestones(backlog.id as number)).map((m) => m.number));
    await this.backlogs.transaction(async (writers) => {
      await writers.saveMilestone({
        backlogId: backlog.id as number,
        number,
        title,
        goal,
        status: 'proposed',
        createdAt: this.clock.iso(),
      });
      await this.support.record(writers, backlog.id as number, who, 'propose milestone', { milestone: `M${number}` });
    });
    return this.queries.view(name);
  }

  /** Accepting is the owner's; the milestone queued behind this one starts in the same write. */
  async acceptMilestone(actor: string | null, name: string, number: number): Promise<BacklogView> {
    const { who, backlog } = await this.support.owned(actor, name);
    const milestones = await this.backlogs.milestones(backlog.id as number);
    const milestone = this.support.milestone(milestones, number);
    checkTransition(milestone.status, 'accepted');
    const next = milestones.find((other) => other.queuedAfterId === milestone.id && other.status === 'queued');
    await this.backlogs.transaction(async (writers) => {
      await writers.saveMilestone({ ...milestone, status: 'accepted' });
      if (next) await writers.saveMilestone({ ...next, status: 'active', queuedAfterId: null });
      await this.support.record(writers, backlog.id as number, who, 'accept milestone', { milestone: `M${number}` });
    });
    return this.queries.view(name);
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

  async addRequirements(
    actor: string | null,
    name: string,
    number: number,
    body: AddRequirementsBody,
  ): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    const milestone = this.support.milestone(await this.backlogs.milestones(backlog.id as number), number);
    if (!Array.isArray(body.texts) || body.texts.length === 0) throw new BadRequestException('no requirement given');
    const texts = body.texts.map((text) => checkText(text, 'a requirement'));
    const taken = (await this.backlogs.requirements(backlog.id as number)).map((requirement) => requirement.ref);
    const refs = nextRequirementRefs(number, taken, texts.length);
    await this.backlogs.transaction(async (writers) => {
      for (const [index, text] of texts.entries()) {
        await writers.saveRequirement({ milestoneId: milestone.id as number, ref: refs[index], text, status: 'open' });
      }
      await this.support.record(writers, backlog.id as number, who, 'add requirements', {
        requirements: refs.join(', '),
      });
    });
    return this.queries.view(name);
  }

  pause(actor: string | null, name: string): Promise<BacklogView> {
    return this.setPaused(actor, name, true);
  }

  unpause(actor: string | null, name: string): Promise<BacklogView> {
    return this.setPaused(actor, name, false);
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

  async recordDecision(actor: string | null, name: string, body: RecordDecisionBody): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    const text = checkText(body.text, 'the decision');
    await this.backlogs.transaction(async (writers) => {
      await writers.addDecision({ backlogId: backlog.id as number, text, who, createdAt: this.clock.iso() });
      await this.support.record(writers, backlog.id as number, who, 'record decision', {});
    });
    return this.queries.view(name);
  }

  addTasks(actor: string | null, name: string, body: AddTaskBody[]): Promise<BacklogView> {
    return this.taskActions.addTasks(actor, name, body);
  }

  changeTask(actor: string | null, name: string, slug: string, body: ChangeTaskBody): Promise<BacklogView> {
    return this.taskActions.changeTask(actor, name, slug, body);
  }

  deleteTask(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.taskActions.deleteTask(actor, name, slug);
  }

  skipTask(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.taskActions.skipTask(actor, name, slug);
  }

  mergeTask(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.taskActions.mergeTask(actor, name, slug);
  }

  runTaskNow(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.taskActions.runTaskNow(actor, name, slug);
  }

  dropItem(actor: string | null, name: string, slug: string): Promise<BacklogView> {
    return this.taskActions.dropItem(actor, name, slug);
  }

  addItem(actor: string | null, name: string, body: AddItemBody): Promise<BacklogView> {
    return this.taskActions.addItem(actor, name, body);
  }

  moveItem(actor: string | null, name: string, slug: string, body: MoveItemBody): Promise<BacklogView> {
    return this.taskActions.moveItem(actor, name, slug, body);
  }

  private async setPaused(actor: string | null, name: string, paused: boolean): Promise<BacklogView> {
    const who = this.support.person(actor);
    const backlog = await this.support.load(name);
    await this.backlogs.transaction(async (writers) => {
      await writers.saveBacklog({ ...backlog, paused });
      await this.support.record(writers, backlog.id as number, who, paused ? 'pause' : 'unpause', {});
    });
    return this.queries.view(name);
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
