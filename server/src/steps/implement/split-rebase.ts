import { Injectable } from '@nestjs/common';
import { settled, type Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { SubtaskOps } from '../shared/subtask-ops';

const MOVED_NOTE = 'rebased onto the epic: the feature branch moved on';

/** The start of every note this queue writes on a task, so a pass that refreshes the task keeps it while the task reruns. */
export const REBASED_PREFIX = 'rebased onto the epic';

/** The words that say why a task was moved onto the feature branch. */
function rebasedNote(sibling: string, files: string[]): string {
  return `rebased onto the epic after ${sibling} merged${files.length > 0 ? ` (conflict in ${files.join(', ')})` : ''}`;
}

/**
 * The part of the merge queue that keeps every open task on top of the feature branch. After a merge, a task whose
 * merge request conflicts is rebased whatever its state; a green task behind the feature branch is rebased before it
 * merges. A task a person stopped, or that waits for a person or a sibling, is left as it is.
 */
@Injectable()
export class SplitRebase {
  constructor(
    private readonly subtasks: SubtaskOps,
    private readonly hosts: CodeHostRegistry,
  ) {}

  /** After `merged` was merged into the feature branch at `tip`: every other open task that now conflicts is rebased. */
  async afterMerge(parent: RunEntity, tasks: Subtask[], merged: Subtask, tip: string): Promise<Subtask[]> {
    const next: Subtask[] = [];
    for (const task of tasks) {
      const child = settled(task) || task.id === merged.id ? null : await this.subtasks.find(parent, task.id);
      next.push(
        child && (await this.conflicts(parent, child)) ? await this.move(parent, task, child, merged, tip) : task,
      );
    }
    return next;
  }

  /** A green task whose head does not contain the feature branch is rebased and its gates run again. The task, or null when it is on top. */
  async behind(parent: RunEntity, task: Subtask, child: RunEntity): Promise<Subtask | null> {
    const tip = await this.subtasks.behindTip(parent, child);
    if (!tip) return null;
    const sent = await this.subtasks.rebase(child, { tip, note: MOVED_NOTE });
    return sent ? { ...task, status: 'running', note: MOVED_NOTE } : task;
  }

  private async conflicts(parent: RunEntity, child: RunEntity): Promise<boolean> {
    const host = (await this.hosts.forRun(parent.startedBy, parent.codeHost)).byName(parent.codeHost);
    for (const request of await this.subtasks.mergeRequests(child)) {
      if ((await host.readMergeRequest(request.project, request.iid)).conflicts) return true;
    }
    return false;
  }

  private async move(
    parent: RunEntity,
    task: Subtask,
    child: RunEntity,
    merged: Subtask,
    tip: string,
  ): Promise<Subtask> {
    const listed = merged.files.filter((file) => task.files.includes(file));
    const found = await this.subtasks.conflictFiles(parent, child);
    const note = rebasedNote(merged.id, found.length > 0 ? found : listed);
    return (await this.subtasks.rebase(child, { tip, note })) ? { ...task, status: 'running', note } : task;
  }
}
