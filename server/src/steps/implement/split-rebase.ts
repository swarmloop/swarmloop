import { Injectable } from '@nestjs/common';
import { settled, type Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { SubtaskOps } from '../shared/subtask-ops';

/** The start of every note this queue writes on a task, so a pass that refreshes the task keeps it while the task reruns. */
export const REBASED_PREFIX = 'rebased onto the epic';

/** The words that say why a task was moved onto an epic that took a new main head. */
export function mainMovedNote(main: string): string {
  return `${REBASED_PREFIX} after main moved on (${main})`;
}

/** The words that say why a task was moved onto the feature branch. */
function rebasedNote(sibling: string, files: string[]): string {
  return `rebased onto the epic after ${sibling} merged${files.length > 0 ? ` (conflict in ${files.join(', ')})` : ''}`;
}

/**
 * The part of the merge queue that keeps every open task on top of the feature branch. After a merge, a task whose
 * merge request conflicts is rebased whatever its state, and a task that waits on a person or a sibling is moved
 * onto the new tip and keeps its wait; the landing rebases a green task that is behind it. A task a
 * person stopped is left as it is.
 */
@Injectable()
export class SplitRebase {
  constructor(
    private readonly subtasks: SubtaskOps,
    private readonly hosts: CodeHostRegistry,
  ) {}

  /** After `merged` was merged into the feature branch at `tip`: every other open task that now conflicts, or waits, is rebased. */
  async afterMerge(parent: RunEntity, tasks: Subtask[], merged: Subtask, tip: string): Promise<Subtask[]> {
    const next: Subtask[] = [];
    for (const task of tasks) {
      const child = settled(task) || task.id === merged.id ? null : await this.subtasks.find(parent, task.id);
      if (child && (await this.conflicts(parent, child))) next.push(await this.move(parent, task, child, merged, tip));
      else if (child && (await this.subtasks.keepsWait(child))) next.push(await this.follow(task, child, merged, tip));
      else next.push(task);
    }
    return next;
  }

  private async conflicts(parent: RunEntity, child: RunEntity): Promise<boolean> {
    const host = await this.hosts.hostFor(parent);
    for (const request of await this.subtasks.mergeRequests(child)) {
      if ((await host.readMergeRequest(request.project, request.iid)).conflicts) return true;
    }
    return false;
  }

  /** A task that waits on a person or a sibling is moved onto the new tip and keeps its wait. */
  private async follow(task: Subtask, child: RunEntity, merged: Subtask, tip: string): Promise<Subtask> {
    await this.subtasks.rebase(child, { tip, note: rebasedNote(merged.id, []) });
    return task;
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
