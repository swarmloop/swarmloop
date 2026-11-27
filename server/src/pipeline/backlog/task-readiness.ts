import type { RepositoryMainView } from '../../contract/repository-main';
import type { RunState } from '../../contract/run-state';
import type { Subtask } from '../../contract/subtask';
import { readyTasks, settled, shownTaskState, unmetDepends, waitNote } from '../../contract/subtask';
import type { BacklogTaskRecord } from '../../history/backlog.repository';
import { cycleFrom, dependencyEdges } from './task-graph';

/** A backlog task as the epic's functions read it, with what the layer adds. */
export interface BacklogTask extends Subtask {
  repositories: string[];
  fixesMain: string | null;
  runKey: string | null;
  covers: string[];
  /** The requirements among its depends, before they stand for tasks. */
  refs: string[];
  /** The dependency cycle among unsettled tasks that this task is in, in words. */
  cycle: string | null;
  /** In an active milestone, or the owner asked to run it now. */
  mayStart: boolean;
  /** A task it depends on that merged and whose merge the planner has not read yet. A task with it set waits. */
  unreadMerge?: string;
}

/** What a repository's main reads as; `none` is a main with no CI, and `unreadable` carries the words for why it could not be read. */
export type MainReading =
  | (Pick<RepositoryMainView, 'state'> & Partial<Pick<RepositoryMainView, 'head'>>)
  | { state: 'unreadable'; note: string };

/** Whether a main lets work start and merge: it is green, or it has no CI. */
export function mainPasses(reading: MainReading | undefined): boolean {
  return reading?.state === 'green' || reading?.state === 'none';
}

/** The state of a task's own run, as far as its shown status needs it. */
export interface RunFacts {
  state: RunState;
  currentStep: string;
}

/** Every task of a backlog as a task with its shown status: a merged or skipped task keeps its status, any other shows its run. */
export function backlogTasks(
  records: BacklogTaskRecord[],
  activeMilestones: ReadonlySet<number>,
  runs: ReadonlyMap<string, RunFacts>,
  unreadMerges: ReadonlySet<string> = new Set(),
): BacklogTask[] {
  const unsettled = records.filter((record) => !settled(record));
  return records.map((record) => {
    const edges = dependencyEdges(record, records);
    const unread = edges.map((edge) => edge.id).find((id) => unreadMerges.has(id));
    const task: BacklogTask = {
      id: record.slug,
      title: record.title,
      description: record.description,
      depends: edges.map((edge) => edge.id),
      files: record.files,
      proof: record.proof.join(', '),
      status: record.status,
      merged: record.merged,
      repositories: record.repositories,
      covers: record.covers,
      refs: [...new Set(edges.flatMap((edge) => (edge.ref === null ? [] : [edge.ref])))],
      cycle: settled(record) ? null : cycleFrom(record.slug, unsettled),
      fixesMain: record.fixesMain,
      runKey: record.runKey,
      mayStart: record.runNow || (record.milestoneId !== null && activeMilestones.has(record.milestoneId)),
      ...(unread === undefined ? {} : { unreadMerge: unread }),
    };
    const run = record.runKey === null ? undefined : runs.get(record.runKey);
    return { ...task, status: shownTaskState(task, run) };
  });
}

/** The tasks that may start now, in plan order: ready by the epic's rules, never started, allowed to start, and no merge they depend on unread. */
export function candidates(tasks: BacklogTask[]): BacklogTask[] {
  return readyTasks(tasks, Infinity).filter(
    (task) => task.mayStart && task.runKey === null && task.unreadMerge === undefined,
  );
}

/** The repositories that the candidates touch, so the scheduler reads each main once. */
export function repositoriesOf(tasks: BacklogTask[]): string[] {
  return [...new Set(tasks.flatMap((task) => task.repositories))];
}

/** The task that fixes a repository's main and is not merged or skipped, other than `task`. */
export function fixerOf(repo: string, task: BacklogTask, tasks: BacklogTask[]): BacklogTask | undefined {
  return tasks.find((other) => other.id !== task.id && other.fixesMain === repo && !settled(other));
}

/** Why a task may not start for the state of a repository's main, or null when it may. Its own fixes_main repository is not asked. */
export function mainWait(
  task: BacklogTask,
  tasks: BacklogTask[],
  mains: ReadonlyMap<string, MainReading>,
): string | null {
  for (const repo of task.repositories) {
    const fixer = fixerOf(repo, task, tasks);
    if (fixer) return `waits for ${fixer.id}, which fixes the main of ${repo}`;
    if (task.fixesMain === repo) continue;
    const reading = mains.get(repo);
    if (reading?.state === 'unreadable') return `waits for a green main of ${repo}: ${reading.note}`;
    if (!mainPasses(reading)) return `waits for a green main of ${repo}`;
  }
  return null;
}

/** The requirements this task depends on whose tasks are not all settled, or that no task covers yet. */
function waitedRefs(task: BacklogTask, tasks: BacklogTask[]): string[] {
  return task.refs.filter((ref) => {
    const covering = tasks.filter((other) => other.id !== task.id && other.covers.includes(ref));
    return covering.length === 0 || covering.some((other) => !settled(other));
  });
}

/** What a task waits for in its dependencies, in words, or null when none holds it. A requirement is named as `<ref>'s tasks`. */
export function dependencyWait(task: BacklogTask, tasks: BacklogTask[]): string | null {
  if (task.unreadMerge !== undefined) return `waits for the planner to read the merge of ${task.unreadMerge}`;
  if (unmetDepends(task, tasks).length === 0) return null;
  if (task.cycle !== null) return `waits in a cycle: ${task.cycle}`;
  const note = waitNote(task, tasks);
  const refs = waitedRefs(task, tasks);
  if (refs.length === 0 || note.endsWith(', which is blocked')) return note;
  const tasksOfRefs = new Set(tasks.filter((other) => other.covers.some((ref) => refs.includes(ref))).map((t) => t.id));
  const direct = unmetDepends(task, tasks).filter((id) => !tasksOfRefs.has(id) && !refs.includes(id));
  return `waits for ${[...refs.map((ref) => `${ref}'s tasks`), ...direct].join(', ')}`;
}

/** The words for a task that is ready but has no free place. */
export function placeWait(started: number): string {
  return `waits for a free place: ${started} of BACKLOG_PARALLEL`;
}
