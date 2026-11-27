import { Injectable } from '@nestjs/common';
import { REASON } from '../../contract/reason-words';
import { BacklogRepository } from '../../history/backlog.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { SUBTASK_ASKING_STEPS } from '../../steps/implement/implement-question';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { readMains } from './main-readings';
import { backlogTasks, fixerOf, mainPasses, mainWait, type BacklogTask, type MainReading } from './task-readiness';

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
   * does not pass (it reads green, or has no CI), or null when the run is not at an implementation step (the only step a red reaches the planner
   * from), has no such task or none of its repositories is held back.
   */
  async repositoryFor(run: RunEntity): Promise<string | null> {
    if (!SUBTASK_ASKING_STEPS.includes(run.currentStep)) return null;
    const found = await this.taskOf(run);
    if (!found) return null;
    const { task, tasks, owner } = found;
    const held = task.repositories.filter((repository) => fixerOf(repository, task, tasks) !== undefined);
    if (held.length === 0) return null;
    const mains = new Map<string, MainReading>();
    await readMains(this.host, held, owner, mains);
    return held.find((repository) => !mainPasses(mains.get(repository))) ?? null;
  }

  /**
   * Releases the run to waiting with the words a backlog task shows for its main. `mains` is a cache of repository
   * mains (the scheduler pass's); the ones it lacks are read.
   */
  async hold(run: RunEntity, repository: string, mains: Map<string, MainReading> = new Map()): Promise<void> {
    const found = await this.taskOf(run);
    if (found) await readMains(this.host, found.task.repositories, found.owner, mains);
    const message = (found && mainWait(found.task, found.tasks, mains)) ?? `waits for a green main of ${repository}`;
    await this.runs.release(run, { status: 'waiting', reason: { code: REASON.waitsForMain, message } });
  }

  private async taskOf(run: RunEntity) {
    const parent = run.parentRunId === null ? null : await this.runs.findById(run.parentRunId);
    const record = await this.backlogs.findTaskByRunKey((parent ?? run).key);
    if (!record) return null;
    const backlog = (await this.backlogs.listBacklogs()).find((found) => found.id === record.backlogId);
    if (!backlog) return null;
    const tasks = backlogTasks(await this.backlogs.tasks(record.backlogId), new Set(), new Map());
    const task = tasks.find((found) => found.runKey === record.runKey) as BacklogTask;
    return { task, tasks, owner: backlog.owner };
  }
}
