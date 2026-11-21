import type { SubtaskStatus } from './subtask';

/** `green` merges a task on green; `ok` waits for the owner. */
export type MergeMode = 'green' | 'ok';
export type MilestoneStatus = 'proposed' | 'queued' | 'active' | 'accepted';
export type RequirementStatus = 'open' | 'ready' | 'closed';
export type TaskMadeBy = 'person' | 'planner';
export type BacklogEventKind =
  | 'task-merged'
  | 'run-needs-person'
  | 'run-done-without-request'
  | 'merge-refused'
  | 'rebase-refused'
  | 'main-red'
  | 'main-green'
  | 'run-chat'
  | 'requirement-ready'
  | 'milestone-ready'
  | 'action';

/** Where a run comes from: the backlog and the milestone number (none for a backlog item). */
export interface RunBacklog {
  name: string;
  milestone: number | null;
}

/** The label of a run's backlog, like `swarmloop · M3`. */
export function backlogLine(label: RunBacklog): string {
  return label.milestone === null ? label.name : `${label.name} · M${label.milestone}`;
}

interface BacklogMilestoneView {
  number: number;
  title: string;
  goal: string;
  status: MilestoneStatus;
}

interface BacklogRequirementView {
  ref: string;
  milestone: number;
  text: string;
  status: RequirementStatus;
  /** The slugs of the merged tasks that closed it; empty for a requirement that is not closed or was closed by hand. */
  closedBy: string[];
}

interface BacklogTaskView {
  slug: string;
  title: string;
  /** What the task is to do, as markdown. */
  description: string;
  /** The refs of the requirements it covers. */
  covers: string[];
  /** The slugs of the tasks it waits for. */
  depends: string[];
  milestone: number | null;
  status: SubtaskStatus;
  /** What the task waits for, in words. */
  note: string;
  runKey: string | null;
  /** True while the task is green and waits for the owner's OK to merge. */
  waitsForOk: boolean;
  repositories: string[];
  /** The merged commit of each repository that is merged. */
  merged: Record<string, string>;
}

interface BacklogDecisionView {
  text: string;
  who: string;
  at: string;
}

interface BacklogEventView {
  kind: BacklogEventKind;
  facts: Record<string, string>;
  at: string;
}

/** What the queries route answers for one backlog. */
export interface BacklogView {
  name: string;
  owner: string;
  repositories: string[];
  mergeMode: MergeMode;
  paused: boolean;
  milestones: BacklogMilestoneView[];
  requirements: BacklogRequirementView[];
  tasks: BacklogTaskView[];
  decisions: BacklogDecisionView[];
  events: BacklogEventView[];
}
