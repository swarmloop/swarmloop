import { Injectable } from '@nestjs/common';
import { REASON } from '../../contract/reason-words';
import { settled } from '../../contract/subtask';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { MainRebaseSend } from './main-rebase-send';
import { readMains } from './main-readings';
import { RedMainWait } from './red-main-wait';
import { backlogTasks, mainWait, type BacklogTask, type MainReading } from './task-readiness';

type Backlog = Awaited<ReturnType<BacklogRepository['listBacklogs']>>[number];

/**
 * Ends the wait of a run that waits for a green main and is neither split nor a part (an epic and its parts end theirs
 * through the epic's main move). While a main of the task's repositories is not green the run keeps waiting and its words
 * follow the main. Once every one reads green the run is sent the plain `rebase` a person's Rebase sends, once per heads
 * key, even when it already holds those heads: the Rebase moves it onto main or finds it there, and resumes it.
 */
@Injectable()
export class MainWaitWake {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
    private readonly host: RepositoryHost,
    private readonly hold: RedMainWait,
    private readonly rebases: MainRebaseSend,
  ) {}

  /** One pass over the unsettled tasks of the backlogs that are not paused. `mains` is the tick's cache of repository mains. */
  async run(backlogs: Backlog[], mains: Map<string, MainReading>): Promise<void> {
    for (const backlog of backlogs.filter((found) => !found.paused)) {
      const records = await this.backlogs.tasks(backlog.id as number);
      const tasks = backlogTasks(records, new Set(), new Map());
      for (const record of records) {
        const run = record.runKey === null || settled(record) ? null : await this.runs.findRun(record.runKey);
        if (!run || run.split || run.parentRunId !== null || !waitsForMain(run)) continue;
        await readMains(this.host, record.repositories, backlog.owner, mains);
        const task = tasks.find((found) => found.id === record.slug) as BacklogTask;
        await this.wake(backlog, record, task, tasks, run, mains);
      }
    }
  }

  private async wake(
    backlog: Backlog,
    record: BacklogTaskRecord,
    task: BacklogTask,
    tasks: BacklogTask[],
    run: RunEntity,
    mains: Map<string, MainReading>,
  ): Promise<void> {
    const waiting = record.repositories.find((repository) => mains.get(repository)?.state !== 'green');
    if (waiting !== undefined) {
      const words = mainWait(task, tasks, new Map([[waiting, { state: 'red' }]]));
      if (words !== null && words !== storedState(run).reason?.message) await this.hold.hold(run, waiting);
      return;
    }
    const named = record.repositories.map((repository) => `${repository}@${headOf(mains.get(repository))}`);
    if (named.length === 0 || named.some((head) => head.endsWith('@'))) return;
    await this.rebases.send({
      backlogId: backlog.id as number,
      task: record.slug,
      run,
      key: `main-wait-${run.key}-${named.join('-')}`,
      payload: {},
      head: named.join(','),
    });
  }
}

function waitsForMain(run: RunEntity): boolean {
  const { state, reason } = storedState(run);
  return state === 'waiting' && reason?.code === REASON.waitsForMain;
}

function headOf(reading: MainReading | undefined): string {
  return reading && 'head' in reading ? (reading.head ?? '') : '';
}
