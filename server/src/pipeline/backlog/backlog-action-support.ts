import { ForbiddenException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Clock } from '../../core/clock';
import type { BacklogView } from '../../contract/backlog';
import { BacklogRepository } from '../../history/backlog.repository';
import { LiveHub } from '../../live/live.hub';
import type { BacklogWriters } from '../../history/backlog-writers';
import type { BacklogQueries } from './backlog-queries';

export type Backlog = NonNullable<Awaited<ReturnType<BacklogRepository['findBacklog']>>>;
export type Milestone = Awaited<ReturnType<BacklogRepository['milestones']>>[number];

/** The planner's turn: its actions read and write on the turn's own writers, and their records say so. */
export interface PlannerContext {
  turn: string;
  writers: BacklogWriters;
}

/** What an action answers: the view of the backlog for a route, nothing for the planner, which reads its own state. */
export type Outcome<Context extends PlannerContext | undefined> = Context extends PlannerContext ? void : BacklogView;

/** The answer of an action once its writes are done. */
export function outcome<Context extends PlannerContext | undefined>(
  queries: Pick<BacklogQueries, 'view'>,
  name: string,
  context?: Context,
): Promise<Outcome<Context>> {
  return (context ? Promise.resolve() : queries.view(name)) as Promise<Outcome<Context>>;
}

/** What every backlog action needs: who acts, the backlog it acts on, and the record of the action. */
@Injectable()
export class BacklogActionSupport {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly clock: Clock,
    @Optional() private readonly hub?: LiveHub,
  ) {}

  person(actor: string | null): string {
    if (actor === null) throw new UnauthorizedException('log in to change a backlog');
    return actor;
  }

  /** Where an action reads: the planner's writers inside its turn, the repository for a person. */
  reads(context?: PlannerContext): BacklogWriters {
    return context?.writers ?? this.backlogs;
  }

  /**
   * Runs the writes of an action in the planner's transaction, or in one of their own. A person's write tells the hub
   * once it is done; the planner's turn ends with its own `backlog` event.
   */
  async write<T>(context: PlannerContext | undefined, work: (writers: BacklogWriters) => Promise<T>): Promise<T> {
    if (context) {
      return work(context.writers);
    }
    const result = await this.backlogs.transaction(work);
    this.hub?.backlogWritten();
    return result;
  }

  async load(name: string, context?: PlannerContext): Promise<Backlog> {
    const backlog = await this.reads(context).findBacklog(name);
    if (backlog === null) throw new NotFoundException(`no backlog ${name}`);
    return backlog;
  }

  async owned(
    actor: string | null,
    name: string,
    context?: PlannerContext,
  ): Promise<{ who: string; backlog: Backlog }> {
    const who = this.person(actor);
    const backlog = await this.load(name, context);
    if (backlog.owner !== who) throw new ForbiddenException(`only ${backlog.owner} can do this on ${name}`);
    return { who, backlog };
  }

  milestone(milestones: Milestone[], number: number): Milestone {
    const found = milestones.find((milestone) => milestone.number === number);
    if (found === undefined) throw new NotFoundException(`no milestone M${number}`);
    return found;
  }

  async record(
    writers: Pick<BacklogRepository, 'recordEvent'>,
    backlogId: number,
    who: string,
    action: string,
    facts: Record<string, string>,
    context?: PlannerContext,
  ): Promise<void> {
    await writers.recordEvent(backlogId, `action:${randomUUID()}`, 'action', {
      ...facts,
      ...(context ? { via: 'the planner', turn: context.turn } : {}),
      action,
      who,
      at: this.clock.iso(),
    });
  }
}
