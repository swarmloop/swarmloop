import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { BacklogTaskRecord, BacklogWriters } from '../../history/backlog-writers';

function listText(label: string, values: string[]): string {
  return `${label}: ${values.length === 0 ? 'none' : values.join(', ')}`;
}

/** The task as it is now, in plain words and in full: a refused change decides again on it. */
async function currentText(writers: BacklogWriters, task: BacklogTaskRecord): Promise<string> {
  const milestone = (await writers.milestones(task.backlogId)).find(({ id }) => id === task.milestoneId);
  return [
    `${task.slug} changed since it was read: it is now revision ${task.revision ?? 0}`,
    `title: ${task.title}`,
    `description: ${task.description}`,
    listText('repositories', task.repositories),
    listText('covers', task.covers),
    listText('depends', task.depends),
    listText('files', task.files),
    listText('proof', task.proof),
    `milestone: ${milestone ? `M${milestone.number}` : 'none'}`,
  ].join('; ');
}

/**
 * Moves the task from the revision a change read to the next one, or refuses with the task as it is now. The one
 * conditional write is `BacklogWriters.claimTask`; a refused change is never applied again on the new record.
 */
export async function claimOrRefuse(writers: BacklogWriters, task: BacklogTaskRecord, expected: number): Promise<void> {
  if (!Number.isInteger(expected) || expected < 0) {
    throw new BadRequestException('the revision of a task is a whole number, 0 or more');
  }
  if (await writers.claimTask(task.id as number, expected)) return;
  const current = (await writers.tasks(task.backlogId)).find(({ id }) => id === task.id);
  if (current === undefined) throw new NotFoundException(`${task.slug} was deleted since it was read`);
  throw new ConflictException(await currentText(writers, current));
}
