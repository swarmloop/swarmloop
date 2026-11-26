import { Injectable } from '@nestjs/common';
import type { RunEntity } from '../../history/entities';
import { EpicTasksMove } from './epic-tasks-move';
import { SubtaskOps } from './subtask-ops';

/** Ends the resolution round of an epic: its own edits are committed, then each open task moves onto the new tip. */
@Injectable()
export class EpicRound {
  constructor(
    private readonly ops: SubtaskOps,
    private readonly move: EpicTasksMove,
  ) {}

  /** A conflict in the epic's own edits moves no task and is returned for the implement agent. */
  async finish(parent: RunEntity): Promise<{ conflict: string | null }> {
    const { conflict } = await this.ops.commitOwnEdits(parent, true);
    if (conflict) return { conflict };
    await this.move.move(parent);
    return { conflict: null };
  }
}
