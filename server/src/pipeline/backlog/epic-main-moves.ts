import { Injectable } from '@nestjs/common';
import { settled } from '../../contract/subtask';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { RunRepository } from '../../history/run.repository';
import type { RunEntity } from '../../history/entities';
import { RunRebase } from '../../steps/run-rebase';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { MainHeld } from './main-held';
import { MainRebaseSend } from './main-rebase-send';
import { readMains } from './main-readings';
import { mainPasses, type MainReading } from './task-readiness';

type Backlog = Awaited<ReturnType<BacklogRepository['listBacklogs']>>[number];

/** A repository whose main is green, or has no CI, at a head an epic does not hold yet. */
interface NewHead {
  repository: string;
  head: string;
}

/**
 * Brings a new green main, or a new main with no CI, into the running epics of the backlogs. An epic whose subtasks are idle is sent the same
 * `rebase` a person's Rebase sends; the key names the epic and the heads, so each head moves an epic once.
 */
@Injectable()
export class EpicMainMoves {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
    private readonly rebaser: RunRebase,
    private readonly held: MainHeld,
    private readonly host: RepositoryHost,
    private readonly rebases: MainRebaseSend,
  ) {}

  /** One pass over the unsettled tasks of the backlogs that are not paused. `mains` is the tick's cache of repository mains. */
  async run(backlogs: Backlog[], mains: Map<string, MainReading>): Promise<void> {
    for (const backlog of backlogs.filter((found) => !found.paused)) {
      for (const task of await this.backlogs.tasks(backlog.id as number)) {
        if (task.runKey === null || settled(task)) continue;
        const epic = await this.runs.findRun(task.runKey);
        if (!epic || !(await this.rebaser.takesMain(epic)) || !(await this.rebaser.subtasksIdle(epic))) continue;
        await readMains(this.host, task.repositories, backlog.owner, mains);
        const heads = await this.newHeads(epic, task, mains);
        if (heads.length > 0) await this.move(backlog, task, epic, heads);
      }
    }
  }

  private async newHeads(epic: RunEntity, task: BacklogTaskRecord, mains: Map<string, MainReading>) {
    const heads: NewHead[] = [];
    for (const repository of task.repositories) {
      const reading = mains.get(repository);
      const head = reading && 'head' in reading ? reading.head : null;
      if (!mainPasses(reading) || !head) continue;
      if (!(await this.held.holds(epic.key, repository, head))) heads.push({ repository, head });
    }
    return heads;
  }

  /** Sends the epic its main move once per head. */
  private async move(backlog: Backlog, task: BacklogTaskRecord, epic: RunEntity, heads: NewHead[]): Promise<void> {
    const named = heads.map(({ repository, head }) => `${repository}@${head}`);
    await this.rebases.send({
      backlogId: backlog.id as number,
      task: task.slug,
      run: epic,
      key: `epic-main-${epic.key}-${named.join('-')}`,
      payload: { main: heads.map(({ repository, head }) => `${repository} at ${head}`).join(', ') },
      head: named.join(','),
    });
  }
}
