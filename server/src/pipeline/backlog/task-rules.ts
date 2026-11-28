import { BadRequestException, ConflictException } from '@nestjs/common';
import { settled } from '../../contract/subtask';
import type { BacklogTaskRecord } from '../../history/backlog.repository';
import { noFileWords } from '../../steps/plan/plan-tasks';
import { findCycle, REQUIREMENT_REF } from './task-graph';

const SLUG = /^[a-z][a-z0-9-]{0,38}$/;

/** The fields of a task that these checks read. */
export type CheckedTask = Pick<BacklogTaskRecord, 'slug' | 'repositories' | 'covers' | 'depends' | 'fixesMain'>;

/** What a task is checked against: the scope, the requirement refs and the other tasks of the backlog. */
export interface TaskScope {
  repositories: string[];
  refs: string[];
  others: (Pick<BacklogTaskRecord, 'slug' | 'depends'> & Partial<Pick<BacklogTaskRecord, 'covers' | 'status'>>)[];
}

/** A task has started when it holds a run key. */
export function isStarted(task: Pick<BacklogTaskRecord, 'runKey'>): boolean {
  return task.runKey !== null;
}

export function checkSlug(slug: unknown): string {
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new BadRequestException(
      'a task id is a lowercase letter, then lowercase letters, digits and dashes, up to 39',
    );
  }
  return slug;
}

/** The slugs of a batch are well formed, unique in it and not taken in the backlog. */
export function checkNewSlugs(slugs: unknown[], taken: string[]): string[] {
  const checked = slugs.map(checkSlug);
  for (const [index, slug] of checked.entries()) {
    if (taken.includes(slug) || checked.indexOf(slug) !== index) {
      throw new ConflictException(`a task ${slug} exists`);
    }
  }
  return checked;
}

/** A change is refused for a started task; the message says where its changes go. */
export function checkNotStartedForChange(task: Pick<BacklogTaskRecord, 'slug' | 'runKey'>): void {
  if (isStarted(task)) {
    throw new ConflictException(`${task.slug} has started: its run takes changes through its own planner`);
  }
}

/** A delete is refused for a started task; skipping is the way out. */
export function checkNotStartedForDelete(task: Pick<BacklogTaskRecord, 'slug' | 'runKey'>): void {
  if (isStarted(task)) throw new ConflictException(`${task.slug} has started: skip it instead`);
}

/** A task that is merged or skipped no longer changes. */
export function checkNotSettled(task: Pick<BacklogTaskRecord, 'slug' | 'status'>): void {
  if (settled(task)) throw new ConflictException(`${task.slug} is already ${task.status}`);
}

function checkList(values: unknown, what: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new BadRequestException(`${what} is a list of text`);
  }
  return values as string[];
}

/** A task in a milestone, or run now, is started on its repositories, so it names at least one. A backlog item may wait without one until it is planned. */
export function checkRunnable(task: Pick<BacklogTaskRecord, 'slug' | 'repositories' | 'milestoneId' | 'runNow'>): void {
  if ((task.milestoneId !== null || task.runNow) && task.repositories.length === 0) {
    throw new BadRequestException(`${task.slug} needs at least one repository to run`);
  }
}

/** A task names every file it changes, as an epic's task does: one with no file is refused, in the epic's words. */
export function checkFiles(task: Pick<BacklogTaskRecord, 'slug' | 'files'>): void {
  if (checkList(task.files, 'files').length === 0) throw new BadRequestException(noFileWords(task.slug));
}

/** Repositories in scope, covers and depends that exist, no cycle, and fixes_main among the task's repositories. */
export function checkTasks(tasks: CheckedTask[], scope: TaskScope): void {
  const slugs = new Set([...scope.others.map((task) => task.slug), ...tasks.map((task) => task.slug)]);
  for (const task of tasks) {
    for (const repository of checkList(task.repositories, 'the repositories')) {
      if (!scope.repositories.includes(repository)) {
        throw new BadRequestException(`${task.slug}: ${repository} is not in the scope of the backlog`);
      }
    }
    for (const ref of checkList(task.covers, 'covers')) {
      if (!REQUIREMENT_REF.test(ref) || !scope.refs.includes(ref)) {
        throw new BadRequestException(`${task.slug}: ${ref} is not a requirement of the backlog`);
      }
    }
    for (const id of checkList(task.depends, 'depends')) {
      if (!slugs.has(id) && !scope.refs.includes(id)) {
        throw new BadRequestException(`${task.slug}: ${id} is neither a task nor a requirement of the backlog`);
      }
    }
    if (task.fixesMain !== null && !task.repositories.includes(task.fixesMain)) {
      throw new BadRequestException(`${task.slug}: ${task.fixesMain} is not one of its repositories`);
    }
  }
  const batch = new Set(tasks.map((task) => task.slug));
  // A settled task holds nothing up, so only unsettled ones can close a cycle, as in readiness.
  const open = scope.others.filter(
    (task) => !batch.has(task.slug) && !(task.status && settled({ status: task.status })),
  );
  const cycle = findCycle([...open, ...tasks]);
  if (cycle) throw new BadRequestException(`the tasks depend on each other in a circle: ${cycle}`);
}
