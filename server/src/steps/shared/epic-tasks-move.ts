import { Injectable } from '@nestjs/common';
import { parseSubtasks, settled, SUBTASKS_KIND } from '../../contract/subtask';
import { CommandRepository } from '../../history/command.repository';
import { DocumentRepository } from '../../history/document.repository';
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

/**
 * The one path that moves an epic's open tasks onto the epic's new tip, for a clean Rebase and for the end of a
 * resolution round. A main move names the tip and says why; a person's Rebase sends the plain move. Each task's move
 * is keyed by the tip, so a second call after a restart sends nothing twice.
 */
@Injectable()
export class EpicTasksMove {
  constructor(
    private readonly ops: SubtaskOps,
    private readonly rebase: RunRebase,
    private readonly commands: CommandRepository,
    private readonly documents: DocumentRepository,
  ) {}

  async move(parent: RunEntity): Promise<void> {
    const tip = await this.rebase.tipOf(parent.key);
    const main = mainOf((await this.commands.latestOfType(parent.id, 'rebase'))?.payload);
    const open = parseSubtasks(await this.documents.latestBody(parent.key, SUBTASKS_KIND)).filter(
      (task) => !settled(task),
    );
    for (const task of open) {
      const child = await this.ops.find(parent, task.id);
      if (!child) continue;
      if (main) await this.ops.rebase(child, { tip, note: mainMovedNote(main) });
      else await this.ops.rebase(child);
    }
  }
}
