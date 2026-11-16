import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Clock } from '../../core/clock';
import { BacklogRepository } from '../../history/backlog.repository';

export type Backlog = NonNullable<Awaited<ReturnType<BacklogRepository['findBacklog']>>>;
export type Milestone = Awaited<ReturnType<BacklogRepository['milestones']>>[number];

/** What every backlog action needs: who acts, the backlog it acts on, and the record of the action. */
@Injectable()
export class BacklogActionSupport {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly clock: Clock,
  ) {}

  person(actor: string | null): string {
    if (actor === null) throw new UnauthorizedException('log in to change a backlog');
    return actor;
  }

  async load(name: string): Promise<Backlog> {
    const backlog = await this.backlogs.findBacklog(name);
    if (backlog === null) throw new NotFoundException(`no backlog ${name}`);
    return backlog;
  }

  async owned(actor: string | null, name: string): Promise<{ who: string; backlog: Backlog }> {
    const who = this.person(actor);
    const backlog = await this.load(name);
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
  ): Promise<void> {
    await writers.recordEvent(backlogId, `action:${randomUUID()}`, 'action', {
      ...facts,
      action,
      who,
      at: this.clock.iso(),
    });
  }
}
