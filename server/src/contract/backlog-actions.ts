import type { MergeMode } from './backlog';

/** The bodies of the backlog actions, shared by the routes and the services that run them. */
export interface CreateBacklogBody {
  name: string;
  repositories: string[];
  mergeMode: MergeMode;
}

export interface ProposeMilestoneBody {
  title: string;
  goal: string;
}

export interface AddRequirementsBody {
  texts: string[];
}

export interface AddRepositoryBody {
  repository: string;
}

export interface RecordDecisionBody {
  text: string;
}

/** The fields of a task that a person or the planner writes. */
interface TaskFieldsBody {
  title: string;
  description: string;
  repositories: string[];
  covers: string[];
  depends: string[];
  files: string[];
  proof: string[];
  manual: boolean;
  fixesMain: string | null;
  /** The milestone number, or none for a backlog item. */
  milestone: number | null;
}

export interface AddTaskBody extends Partial<TaskFieldsBody> {
  id: string;
  title: string;
  description: string;
}

/** A change of a task that has not started: only the fields that are given. */
export type ChangeTaskBody = Partial<Omit<TaskFieldsBody, 'manual' | 'fixesMain'>>;

/** A backlog item: only a title and a description until it is planned. */
export interface AddItemBody {
  id: string;
  title: string;
  description: string;
}

export interface MoveItemBody {
  /** The number of the milestone the item goes to. */
  milestone: number;
}

/** Closing a requirement says what shows it is met. */
export interface CloseRequirementBody {
  evidence: string;
}
