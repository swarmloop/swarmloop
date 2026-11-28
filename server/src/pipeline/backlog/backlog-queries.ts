import { Injectable, NotFoundException } from '@nestjs/common';
import type { BacklogTaskView, BacklogView } from '../../contract/backlog';
import type { AcceptedMilestone } from '../../contract/overview-done';
import { BacklogRepository } from '../../history/backlog.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { shownFacts } from './planner/planner-record-facts';

const EVENT_LIMIT = 50;

/** What the routes answer about backlogs. It only reads. */
@Injectable()
export class BacklogQueries {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
  ) {}

  async list(): Promise<BacklogView[]> {
    return Promise.all((await this.backlogs.listBacklogs()).map((backlog) => this.build(backlog)));
  }

  async view(name: string): Promise<BacklogView> {
    const backlog = await this.backlogs.findBacklog(name);
    if (backlog === null) throw new NotFoundException(`no backlog ${name}`);
    return this.build(backlog);
  }

  /**
   * The accepted milestones of every backlog and the run keys of their tasks. It reads the backlogs, milestones
   * and tasks only, never a run, so its statements grow with the backlogs and not with the runs.
   */
  async acceptedMilestones(): Promise<AcceptedMilestone[]> {
    const found = await Promise.all(
      (await this.backlogs.listBacklogs()).map(async (backlog) => {
        const id = backlog.id as number;
        const [milestones, tasks] = await Promise.all([this.backlogs.milestones(id), this.backlogs.tasks(id)]);
        return milestones
          .filter((milestone) => milestone.status === 'accepted')
          .map((milestone) => ({
            backlog: backlog.name,
            number: milestone.number,
            title: milestone.title,
            runKeys: tasks.filter((task) => task.milestoneId === milestone.id).flatMap((task) => task.runKey ?? []),
          }));
      }),
    );
    return found.flat();
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
    const runStates = await this.runStates(tasks);
    const numbers = new Map(milestones.map((milestone) => [milestone.id as number, milestone.number]));
    const numberOf = (milestoneId: number | null) => (milestoneId === null ? null : (numbers.get(milestoneId) ?? null));
    return {
      name: backlog.name,
      owner: backlog.owner,
      repositories: backlog.repositories,
      mergeMode: backlog.mergeMode,
      paused: backlog.paused,
      milestones: milestones.map(({ number, title, goal, status, queuedAfterId }) => ({
        number,
        title,
        goal,
        status,
        queuedAfter: numberOf(queuedAfterId ?? null),
      })),
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
        run: task.runKey === null ? null : (runStates.get(task.runKey) ?? null),
        waitsForOk:
          task.runKey !== null &&
          task.status === 'green' &&
          !task.mergeOk &&
          (backlog.mergeMode === 'ok' || task.manual),
        repositories: task.repositories,
        merged: task.merged,
        revision: task.revision ?? 0,
      })),
      decisions: decisions.map(({ text, who, createdAt }) => ({ text, who, at: createdAt })),
      events: events.map(({ kind, facts, createdAt }) => ({ kind, facts: shownFacts(facts), at: createdAt })),
    };
  }

  /** The stored state of each task's run, read from the run's own row; a key the server does not know has none. */
  private async runStates(tasks: { runKey: string | null }[]): Promise<Map<string, BacklogTaskView['run']>> {
    const keys = [...new Set(tasks.flatMap((task) => (task.runKey === null ? [] : [task.runKey])))];
    const states = new Map<string, BacklogTaskView['run']>();
    await Promise.all(
      keys.map(async (key) => {
        const row = await this.runs.findRun(key);
        if (row === null) return;
        const { state, reason } = storedState(row);
        states.set(key, { state, stateReason: reason });
      }),
    );
    return states;
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
