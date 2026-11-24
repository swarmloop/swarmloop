import { Injectable } from '@nestjs/common';
import { settled, type Subtask } from '../../contract/subtask';
import { CommandRepository } from '../../history/command.repository';
import type { RunEntity } from '../../history/entities';
import { mainMovedNote } from '../implement/split-rebase';
import { RunRebase } from '../run-rebase';
import { SubtaskOps } from './subtask-ops';

/** The `main` a stored rebase command names, or null for a person's Rebase. */
function mainOf(payload: string | undefined): string | null {
  if (!payload) return null;
  const { main } = JSON.parse(payload) as { main?: unknown };
  return typeof main === 'string' && main ? main : null;
}

/** Ends the resolution round of an epic: its own edits are committed, then each open task moves onto the new tip. */
@Injectable()
export class EpicRound {
  constructor(
    private readonly ops: SubtaskOps,
    private readonly rebase: RunRebase,
    private readonly commands: CommandRepository,
  ) {}

  /** A conflict in the epic's own edits moves no task and is returned for the implement agent. */
  async finish(parent: RunEntity, tasks: Subtask[]): Promise<{ conflict: string | null }> {
    const { conflict } = await this.ops.commitOwnEdits(parent, true);
    if (conflict) return { conflict };
    const tip = await this.rebase.tipOf(parent.key);
    const main = mainOf((await this.commands.latestOfType(parent.id, 'rebase'))?.payload);
    for (const task of tasks.filter((item) => !settled(item))) {
      const child = await this.ops.find(parent, task.id);
      if (!child) continue;
      if (main) await this.ops.rebase(child, { tip, note: mainMovedNote(main) });
      else await this.ops.rebase(child);
    }
    return { conflict: null };
  }
}
