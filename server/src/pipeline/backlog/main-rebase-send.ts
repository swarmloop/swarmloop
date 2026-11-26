import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../core/clock';
import type { RunEntity } from '../../history/entities';
import { CommandService } from '../command.service';
import { BacklogEvents } from './backlog-events';

/** One try to bring main into a run: whose backlog and task it is for, the command's key and payload, and the heads it names. */
interface MainRebase {
  backlogId: number;
  task: string;
  run: RunEntity;
  /** The key of the move; each head moves a run once. */
  key: string;
  payload: Record<string, unknown>;
  /** The repositories at their heads, as the rebase-refused event names them. */
  head: string;
}

/**
 * Sends a run the `rebase` command once per key. The last try is read from the stored command: one that failed for a
 * reason of its own is written as the rebase-refused event and not sent again; one that failed on a code host outage
 * is sent again once, after the next try the outage named.
 */
@Injectable()
export class MainRebaseSend {
  private readonly logger = new Logger(MainRebaseSend.name);

  constructor(
    private readonly commands: CommandService,
    private readonly events: BacklogEvents,
    private readonly clock: Clock,
  ) {}

  async send({ backlogId, task, run, key, payload, head }: MainRebase): Promise<void> {
    const last = await this.lastTry(run, key);
    let idempotencyKey = key;
    if (last) {
      if (last.state !== 'failed') return;
      const { message, retryAt } = failureOf(last);
      if (retryAt === undefined) {
        await this.events.rebaseRefused(backlogId, { task, head, message });
        return;
      }
      if (Date.parse(retryAt) > this.clock.now()) return;
      idempotencyKey = `${key}-after-${last.id}`;
    }
    try {
      await this.commands.accept('rebase', run.key, payload, { idempotencyKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${run.key} did not take main: ${message}`);
      await this.events.rebaseRefused(backlogId, { task, head, message });
    }
  }

  /** The newest command of this move: the try after an outage when there is one, else the first. */
  private async lastTry(run: RunEntity, key: string) {
    const after = await this.commands.latestByKeyPrefix(run.id, `${key}-after-`);
    if (after) return after;
    const first = await this.commands.latestByKeyPrefix(run.id, key);
    return first?.idempotencyKey === key ? first : null;
  }
}

/** Why a command failed, and when the next try of a code host outage is; no time for any other reason. */
function failureOf(command: { result: string | null }): { message: string; retryAt?: string } {
  const stored = JSON.parse(command.result ?? 'null') as { error?: { message?: string; retryAt?: string } } | null;
  return { message: stored?.error?.message ?? 'the rebase failed', retryAt: stored?.error?.retryAt };
}
