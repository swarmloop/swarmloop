import { Injectable, Logger } from '@nestjs/common';
import { settled } from '../../contract/subtask';
import { BacklogRepository, type BacklogTaskRecord } from '../../history/backlog.repository';
import { RunRepository } from '../../history/run.repository';
import type { RunEntity } from '../../history/entities';
import { Clock } from '../../core/clock';
import { RunRebase } from '../../steps/run-rebase';
import { betweenPasses } from '../../steps/shared/epic-between-passes';
import { RepositoryHost } from '../../steps/shared/repository-host';
import { CommandService } from '../command.service';
import { BacklogEvents } from './backlog-events';
import { MainHeld } from './main-held';
import { readMains } from './main-readings';
import type { MainReading } from './task-readiness';

type Backlog = Awaited<ReturnType<BacklogRepository['listBacklogs']>>[number];

/** A repository whose main is green at a head an epic does not hold yet. */
interface NewHead {
  repository: string;
  head: string;
}

/**
 * Brings a new green main into the running epics of the backlogs. An epic whose subtasks are idle is sent the same
 * `rebase` a person's Rebase sends; the key names the epic and the heads, so each head moves an epic once.
 */
@Injectable()
export class EpicMainMoves {
  private readonly logger = new Logger(EpicMainMoves.name);

  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
    private readonly rebaser: RunRebase,
    private readonly held: MainHeld,
    private readonly host: RepositoryHost,
    private readonly commands: CommandService,
    private readonly events: BacklogEvents,
    private readonly clock: Clock,
  ) {}

  /** One pass over the unsettled tasks of the backlogs that are not paused. `mains` is the tick's cache of repository mains. */
  async run(backlogs: Backlog[], mains: Map<string, MainReading>): Promise<void> {
    for (const backlog of backlogs.filter((found) => !found.paused)) {
      for (const task of await this.backlogs.tasks(backlog.id as number)) {
        if (task.runKey === null || settled(task)) continue;
        const epic = await this.runs.findRun(task.runKey);
        if (!epic?.split || !betweenPasses(epic) || !(await this.rebaser.subtasksIdle(epic))) continue;
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
      if (reading?.state !== 'green' || !reading.head) continue;
      if (!(await this.held.holds(epic.key, repository, reading.head))) heads.push({ repository, head: reading.head });
    }
    return heads;
  }

  /**
   * Sends the epic its main move once per head. The last try is read from the stored command: one that failed for a
   * reason of its own is written as the rebase-refused event and not sent again; one that failed on a code host outage
   * is sent again once, after the next try the outage named.
   */
  private async move(backlog: Backlog, task: BacklogTaskRecord, epic: RunEntity, heads: NewHead[]): Promise<void> {
    const named = heads.map(({ repository, head }) => `${repository}@${head}`);
    const key = `epic-main-${epic.key}-${named.join('-')}`;
    const payload = { main: heads.map(({ repository, head }) => `${repository} at ${head}`).join(', ') };
    const last = await this.lastTry(epic, key);
    let idempotencyKey = key;
    if (last) {
      if (last.state !== 'failed') return;
      const { message, retryAt } = failureOf(last);
      if (retryAt === undefined) {
        await this.events.rebaseRefused(backlog.id as number, { task: task.slug, head: named.join(','), message });
        return;
      }
      if (Date.parse(retryAt) > this.clock.now()) return;
      idempotencyKey = `${key}-after-${last.id}`;
    }
    try {
      await this.commands.accept('rebase', epic.key, payload, { idempotencyKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${epic.key} did not take main: ${message}`);
      await this.events.rebaseRefused(backlog.id as number, { task: task.slug, head: named.join(','), message });
    }
  }

  /** The newest command of this move: the try after an outage when there is one, else the first. */
  private async lastTry(epic: RunEntity, key: string) {
    const after = await this.commands.latestByKeyPrefix(epic.id, `${key}-after-`);
    if (after) return after;
    const first = await this.commands.latestByKeyPrefix(epic.id, key);
    return first?.idempotencyKey === key ? first : null;
  }
}

/** Why a command failed, and when the next try of a code host outage is; no time for any other reason. */
function failureOf(command: { result: string | null }): { message: string; retryAt?: string } {
  const stored = JSON.parse(command.result ?? 'null') as { error?: { message?: string; retryAt?: string } } | null;
  return { message: stored?.error?.message ?? 'the rebase failed', retryAt: stored?.error?.retryAt };
}
