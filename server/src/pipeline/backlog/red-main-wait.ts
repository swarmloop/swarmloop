import { Injectable } from '@nestjs/common';
import { REASON } from '../../contract/reason-words';
import { BacklogRepository } from '../../history/backlog.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { readMains } from './main-readings';
import { backlogTasks, fixerOf, mainWait, type BacklogTask, type MainReading, type RunFacts } from './task-readiness';

/** A run whose red is its repository's red main: it waits for a green main the way a backlog task does. */
@Injectable()
export class RedMainWait {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
    private readonly host: RepositoryHost,
  ) {}

  /**
   * The first repository of the run's backlog task (its epic's task for a part) that an unsettled task fixes and whose main
   * does not read green, or null when the run has no such task or none of its repositories is held back.
   */
  async repositoryFor(run: RunEntity): Promise<string | null> {
    const found = await this.taskOf(run);
    if (!found) return null;
    const { task, tasks, owner } = found;
    const held = task.repositories.filter((repository) => fixerOf(repository, task, tasks) !== undefined);
    if (held.length === 0) return null;
    const mains = new Map<string, MainReading>();
    await readMains(this.host, held, owner, mains);
    return held.find((repository) => mains.get(repository)?.state !== 'green') ?? null;
  }

  /** Releases the run to waiting with the words a backlog task shows for its main. */
  async hold(run: RunEntity, repository: string): Promise<void> {
    const found = await this.taskOf(run);
    const mains = new Map<string, MainReading>([[repository, { state: 'red' }]]);
    const message = (found && mainWait(found.task, found.tasks, mains)) ?? `waits for a green main of ${repository}`;
    await this.runs.release(run, { status: 'waiting', reason: { code: REASON.waitsForMain, message } });
  }

  private async taskOf(run: RunEntity) {
    const parent = run.parentRunId === null ? null : await this.runs.findById(run.parentRunId);
    const record = await this.backlogs.findTaskByRunKey((parent ?? run).key);
    if (!record) return null;
    const backlog = (await this.backlogs.listBacklogs()).find((found) => found.id === record.backlogId);
    if (!backlog) return null;
    const stored = await this.backlogs.tasks(record.backlogId);
    const milestones = await this.backlogs.milestones(record.backlogId);
    const active = new Set(milestones.filter((milestone) => milestone.status === 'active').map((m) => m.id as number));
    const facts = new Map<string, RunFacts>();
    for (const task of stored) {
      const taskRun = task.runKey === null ? null : await this.runs.findRun(task.runKey);
      if (task.runKey !== null && taskRun) {
        facts.set(task.runKey, { state: storedState(taskRun).state, currentStep: taskRun.currentStep });
      }
    }
    const tasks = backlogTasks(stored, active, facts);
    const task = tasks.find((found) => found.runKey === record.runKey) as BacklogTask;
    return { task, tasks, owner: backlog.owner };
  }
}
