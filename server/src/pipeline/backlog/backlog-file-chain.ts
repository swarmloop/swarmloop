import { settled, type Subtask } from '../../contract/subtask';
import type { BacklogTaskRecord } from '../../history/backlog.repository';
import { chainSharedFiles } from '../../steps/plan/plan-tasks';
import type { BacklogWriters, MilestoneRecord } from '../../history/backlog-writers';
import { claimOrRefuse } from './task-claim';
import { milestoneStartOrder } from './backlog-rules';
import { isStarted } from './task-rules';

/** The backlog's tasks with the dependencies the shared files added, the tasks that gained one and one decision line per edge. */
export interface ChainedBacklog {
  tasks: BacklogTaskRecord[];
  /** The slugs of the tasks that gained a dependency. */
  touched: string[];
  /** The epic's own line for each edge: `<later> depends on <earlier>: both change <file>`. */
  decisions: string[];
}

/**
 * Chains every task of the backlog that is not settled by the epic's `chainSharedFiles`: a started task counts as
 * earlier than every task that has not started, the others go in plan order: by the order their milestones start in
 * (the active one, the chain queued behind it, the rest by number; an item with no milestone last), then by position.
 * A task the owner asked to run now ranks with the active milestone, whatever its milestone.
 * So a task never waits for one that cannot start before it, and no edge is added to a started task.
 * Every file counts, docs too. A settled task holds nothing up: it gains no edge and gives none. Requirement refs among
 * the depends are left out of the chaining, as the dependency check reads them on the chained result.
 */
export function chainBacklog(records: BacklogTaskRecord[], milestones: MilestoneRecord[]): ChainedBacklog {
  const starts = milestoneStartOrder(milestones.map((milestone) => ({ ...milestone, id: milestone.id as number })));
  const rank = (record: BacklogTaskRecord) => {
    if (record.runNow) return 0;
    return record.milestoneId === null ? Infinity : starts.indexOf(record.milestoneId);
  };
  const open = records
    .filter((record) => !settled(record))
    .sort((a, b) => rank(a) - rank(b) || a.position - b.position);
  const slugs = new Set(open.map((record) => record.slug));
  const copies: Subtask[] = open.map((record) => ({
    id: record.slug,
    title: record.title,
    description: record.description,
    depends: record.depends.filter((id) => slugs.has(id)),
    files: record.files,
    proof: '',
    status: 'pending',
  }));
  const kept = new Map(copies.map((copy) => [copy.id, copy.depends.length]));
  const started = new Set(open.filter(isStarted).map((record) => record.slug));
  const decisions = chainSharedFiles(copies, started);
  const added = new Map(copies.map((copy) => [copy.id, copy.depends.slice(kept.get(copy.id))]));
  const tasks = records.map((record) => {
    const gained = added.get(record.slug) ?? [];
    return gained.length === 0 ? record : { ...record, depends: [...record.depends, ...gained] };
  });
  const touched = records.filter((record) => (added.get(record.slug) ?? []).length > 0).map((record) => record.slug);
  return { tasks, touched, decisions };
}

/**
 * Writes what a chained action added besides its own tasks: each other task that gained an edge is claimed at the
 * revision it was read at and saved as read with the added depends, and each edge is a decision of the actor, so the
 * backlog page shows why a task waits.
 */
export async function saveEdges(
  writers: BacklogWriters,
  chained: ChainedBacklog,
  own: ReadonlySet<string>,
  edit: { backlogId: number; who: string; at: string },
): Promise<void> {
  for (const record of chained.tasks.filter((task) => chained.touched.includes(task.slug) && !own.has(task.slug))) {
    await claimOrRefuse(writers, record, record.revision ?? 0);
    await writers.saveTask(record);
  }
  for (const text of chained.decisions) {
    await writers.addDecision({ backlogId: edit.backlogId, text, who: edit.who, createdAt: edit.at });
  }
}
