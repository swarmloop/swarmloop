import { Injectable, NotFoundException } from '@nestjs/common';
import type { BacklogView } from '../../contract/backlog';
import { BacklogRepository } from '../../history/backlog.repository';
import { shownFacts } from './planner/planner-record-facts';

const EVENT_LIMIT = 50;

/** What the routes answer about backlogs. It only reads. */
@Injectable()
export class BacklogQueries {
  constructor(private readonly backlogs: BacklogRepository) {}

  async list(): Promise<BacklogView[]> {
    return Promise.all((await this.backlogs.listBacklogs()).map((backlog) => this.build(backlog)));
  }

  async view(name: string): Promise<BacklogView> {
    const backlog = await this.backlogs.findBacklog(name);
    if (backlog === null) throw new NotFoundException(`no backlog ${name}`);
    return this.build(backlog);
  }

  private async build(
    backlog: NonNullable<Awaited<ReturnType<BacklogRepository['findBacklog']>>>,
  ): Promise<BacklogView> {
    const id = backlog.id as number;
    const [milestones, requirements, tasks, decisions, events] = await Promise.all([
      this.backlogs.milestones(id),
      this.backlogs.requirements(id),
      this.backlogs.tasks(id),
      this.backlogs.decisions(id),
      this.backlogs.events(id, EVENT_LIMIT),
    ]);
    const numbers = new Map(milestones.map((milestone) => [milestone.id as number, milestone.number]));
    const numberOf = (milestoneId: number | null) => (milestoneId === null ? null : (numbers.get(milestoneId) ?? null));
    return {
      name: backlog.name,
      owner: backlog.owner,
      repositories: backlog.repositories,
      mergeMode: backlog.mergeMode,
      paused: backlog.paused,
      milestones: milestones.map(({ number, title, goal, status }) => ({ number, title, goal, status })),
      requirements: requirements.map((requirement) => ({
        ref: requirement.ref,
        milestone: numberOf(requirement.milestoneId) as number,
        text: requirement.text,
        status: requirement.status,
        closedBy: this.closedBy(requirement, tasks),
      })),
      tasks: tasks.map((task) => ({
        slug: task.slug,
        title: task.title,
        description: task.description,
        covers: task.covers,
        depends: task.depends,
        milestone: numberOf(task.milestoneId),
        status: task.status,
        note: task.note,
        runKey: task.runKey,
        waitsForOk:
          task.runKey !== null &&
          task.status === 'green' &&
          !task.mergeOk &&
          (backlog.mergeMode === 'ok' || task.manual),
        repositories: task.repositories,
        merged: task.merged,
      })),
      decisions: decisions.map(({ text, who, createdAt }) => ({ text, who, at: createdAt })),
      events: events.map(({ kind, facts, createdAt }) => ({ kind, facts: shownFacts(facts), at: createdAt })),
    };
  }

  /** The merged tasks that cover a closed requirement, in task order; a hand close has none. */
  private closedBy(
    requirement: { ref: string; status: string },
    tasks: { slug: string; status: string; covers: string[] }[],
  ): string[] {
    if (requirement.status !== 'closed') return [];
    return tasks
      .filter((task) => task.status === 'merged' && task.covers.includes(requirement.ref))
      .map((task) => task.slug);
  }
}
