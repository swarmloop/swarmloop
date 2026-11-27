import { ConflictException } from '@nestjs/common';
import type { CommandEntity } from '../history/entities';
import type { CommandRepository } from '../history/command.repository';

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** What callers wait for: the end of a command, from the executor of this process or from what an earlier one stored. */
export class CommandOutcomes {
  private readonly waiters = new Map<string, ((outcome: Outcome) => void)[]>();

  constructor(private readonly commands: CommandRepository) {}

  settle(id: string, outcome: Outcome): void {
    const waiting = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    waiting.forEach((resolve) => resolve(outcome));
  }

  /** Waits for the executor, or reads what an earlier executor stored. */
  outcome(command: CommandEntity): Promise<Outcome> {
    return new Promise((resolve) => {
      this.waiters.set(command.id, [...(this.waiters.get(command.id) ?? []), resolve]);
      void this.commands.find(command.id).then((stored) => {
        if (stored?.state === 'succeeded' || stored?.state === 'failed' || stored?.state === 'superseded') {
          this.settle(command.id, stored.state === 'succeeded' ? this.storedValue(stored) : this.storedError(stored));
        }
      });
    });
  }

  private storedValue(stored: CommandEntity): Outcome {
    const result = JSON.parse(stored.result ?? 'null') as { value?: unknown } | null;
    return { ok: true, value: result?.value };
  }

  private storedError(stored: CommandEntity): Outcome {
    const result = JSON.parse(stored.result ?? 'null') as { error?: { message: string } } | null;
    return { ok: false, error: new ConflictException(result?.error?.message ?? `the command is ${stored.state}`) };
  }
}
