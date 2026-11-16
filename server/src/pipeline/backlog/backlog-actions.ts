import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { BacklogView } from '../../contract/backlog';
import type {
  AddRepositoryBody,
  AddRequirementsBody,
  CreateBacklogBody,
  ProposeMilestoneBody,
  RecordDecisionBody,
} from '../../contract/backlog-actions';
import { listGitProjects } from '../../config/checkout-path';
import { AppConfig } from '../../config/env';
import { SwarmloopError } from '../../core/swarmloop-error';
import { Clock } from '../../core/clock';
import { BacklogRepository } from '../../history/backlog.repository';
import { root } from '../../history/run-paths';
import { BacklogQueries } from './backlog-queries';
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

type Backlog = NonNullable<Awaited<ReturnType<BacklogRepository['findBacklog']>>>;
type Milestone = Awaited<ReturnType<BacklogRepository['milestones']>>[number];

/** The only writer of backlogs: it validates, writes in one transaction and records who did it and when. */
@Injectable()
export class BacklogActions {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly queries: BacklogQueries,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  async createBacklog(actor: string | null, body: CreateBacklogBody): Promise<BacklogView> {
    const who = this.person(actor);
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
      await this.record(writers, saved.id as number, who, 'create backlog', { repositories: repositories.join(', ') });
    });
    return this.queries.view(name);
  }

  async proposeMilestone(actor: string | null, name: string, body: ProposeMilestoneBody): Promise<BacklogView> {
    const who = this.person(actor);
    const backlog = await this.load(name);
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
      await this.record(writers, backlog.id as number, who, 'propose milestone', { milestone: `M${number}` });
    });
    return this.queries.view(name);
  }

  /** Accepting is the owner's; the milestone queued behind this one starts in the same write. */
  async acceptMilestone(actor: string | null, name: string, number: number): Promise<BacklogView> {
    const { who, backlog } = await this.owned(actor, name);
    const milestones = await this.backlogs.milestones(backlog.id as number);
    const milestone = this.milestone(milestones, number);
    checkTransition(milestone.status, 'accepted');
    const next = milestones.find((other) => other.queuedAfterId === milestone.id && other.status === 'queued');
    await this.backlogs.transaction(async (writers) => {
      await writers.saveMilestone({ ...milestone, status: 'accepted' });
      if (next) await writers.saveMilestone({ ...next, status: 'active', queuedAfterId: null });
      await this.record(writers, backlog.id as number, who, 'accept milestone', { milestone: `M${number}` });
    });
    return this.queries.view(name);
  }

  async runMilestone(actor: string | null, name: string, number: number): Promise<BacklogView> {
    const { who, backlog } = await this.owned(actor, name);
    const milestone = this.milestone(await this.backlogs.milestones(backlog.id as number), number);
    checkTransition(milestone.status, 'active');
    await this.backlogs.transaction(async (writers) => {
      await writers.saveMilestone({ ...milestone, status: 'active', queuedAfterId: null });
      await this.record(writers, backlog.id as number, who, 'run milestone', { milestone: `M${number}` });
    });
    return this.queries.view(name);
  }

  /** Starts the first proposed milestone and queues the other proposed ones behind it, in number order. */
  async runBacklog(actor: string | null, name: string): Promise<BacklogView> {
    const { who, backlog } = await this.owned(actor, name);
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
      await this.record(writers, backlog.id as number, who, 'run backlog', { milestones: String(moves.length) });
    });
    return this.queries.view(name);
  }

  async addRequirements(
    actor: string | null,
    name: string,
    number: number,
    body: AddRequirementsBody,
  ): Promise<BacklogView> {
    const who = this.person(actor);
    const backlog = await this.load(name);
    const milestone = this.milestone(await this.backlogs.milestones(backlog.id as number), number);
    if (!Array.isArray(body.texts) || body.texts.length === 0) throw new BadRequestException('no requirement given');
    const texts = body.texts.map((text) => checkText(text, 'a requirement'));
    const taken = (await this.backlogs.requirements(backlog.id as number)).map((requirement) => requirement.ref);
    const refs = nextRequirementRefs(number, taken, texts.length);
    await this.backlogs.transaction(async (writers) => {
      for (const [index, text] of texts.entries()) {
        await writers.saveRequirement({ milestoneId: milestone.id as number, ref: refs[index], text, status: 'open' });
      }
      await this.record(writers, backlog.id as number, who, 'add requirements', { requirements: refs.join(', ') });
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
    const { who, backlog } = await this.owned(actor, name);
    const [repository] = checkRepositories([body.repository], this.checkouts());
    if (backlog.repositories.includes(repository)) throw new ConflictException(`${repository} is already in scope`);
    await this.backlogs.transaction(async (writers) => {
      await writers.saveBacklog({ ...backlog, repositories: [...backlog.repositories, repository] });
      await this.record(writers, backlog.id as number, who, 'add repository', { repository });
    });
    return this.queries.view(name);
  }

  async recordDecision(actor: string | null, name: string, body: RecordDecisionBody): Promise<BacklogView> {
    const who = this.person(actor);
    const backlog = await this.load(name);
    const text = checkText(body.text, 'the decision');
    await this.backlogs.transaction(async (writers) => {
      await writers.addDecision({ backlogId: backlog.id as number, text, who, createdAt: this.clock.iso() });
      await this.record(writers, backlog.id as number, who, 'record decision', {});
    });
    return this.queries.view(name);
  }

  private async setPaused(actor: string | null, name: string, paused: boolean): Promise<BacklogView> {
    const who = this.person(actor);
    const backlog = await this.load(name);
    await this.backlogs.transaction(async (writers) => {
      await writers.saveBacklog({ ...backlog, paused });
      await this.record(writers, backlog.id as number, who, paused ? 'pause' : 'unpause', {});
    });
    return this.queries.view(name);
  }

  private person(actor: string | null): string {
    if (actor === null) throw new UnauthorizedException('log in to change a backlog');
    return actor;
  }

  private async load(name: string): Promise<Backlog> {
    const backlog = await this.backlogs.findBacklog(name);
    if (backlog === null) throw new NotFoundException(`no backlog ${name}`);
    return backlog;
  }

  private async owned(actor: string | null, name: string): Promise<{ who: string; backlog: Backlog }> {
    const who = this.person(actor);
    const backlog = await this.load(name);
    if (backlog.owner !== who) throw new ForbiddenException(`only ${backlog.owner} can do this on ${name}`);
    return { who, backlog };
  }

  private milestone(milestones: Milestone[], number: number): Milestone {
    const found = milestones.find((milestone) => milestone.number === number);
    if (found === undefined) throw new NotFoundException(`no milestone M${number}`);
    return found;
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

  private async record(
    writers: Pick<BacklogRepository, 'recordEvent'>,
    backlogId: number,
    who: string,
    action: string,
    facts: Record<string, string>,
  ): Promise<void> {
    await writers.recordEvent(backlogId, `action:${randomUUID()}`, 'action', {
      ...facts,
      action,
      who,
      at: this.clock.iso(),
    });
  }
}
