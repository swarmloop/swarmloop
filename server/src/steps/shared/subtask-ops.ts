import type { RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';
import type { OpenedStep } from '../step-run';

/** One merge request of a subtask: the repository it is for, and where the host has it. */
export interface SubtaskMergeRequest {
  repo: string;
  project: string;
  iid: number;
}

/**
 * What the split pass needs of the runs of its subtasks. It is a token: the pipeline layer provides it, so a step
 * never imports `pipeline` or `api`.
 */
export abstract class SubtaskOps {
  /** The waiting run of a task. It has no worktree until it starts. */
  abstract open(parent: RunEntity, task: Subtask): Promise<RunEntity>;
  /** Starts the run of a task that `open` made. A run that has started stays as it is. */
  abstract launch(parent: RunEntity, task: Subtask): Promise<void>;
  /** Resumes a subtask that a Stop left behind. */
  abstract resume(run: RunEntity): Promise<void>;
  /** The run of a task, when it has one. */
  abstract find(parent: RunEntity, taskId: string): Promise<RunEntity | null>;
  /** Says in the waiting run of a task what it waits for. */
  abstract waitFor(run: RunEntity, message: string): Promise<void>;
  /** True when no pipeline ran for the merge request of a subtask run. */
  abstract withoutCi(run: RunEntity): Promise<boolean>;
  /** The `already delivered: <where>` note of a subtask run that ended without a change, or null. */
  abstract deliveredNote(run: RunEntity): Promise<string | null>;
  /** The merge requests of a subtask run, in the order of its repositories. None until the run opened them. */
  abstract mergeRequests(run: RunEntity): Promise<SubtaskMergeRequest[]>;
  /** The branch of a subtask run. */
  abstract branchOf(run: RunEntity): Promise<string>;
  /** Moves the worktrees of the parent to the feature branch as it is on origin. */
  abstract fastForward(parent: RunEntity): Promise<void>;
  /** Sends a subtask run the Rebase command, when it has a merge request and is in a state that takes it. */
  abstract rebase(run: RunEntity): Promise<void>;
  /** True when the run waits in research for answers to its questions. */
  abstract asking(run: RunEntity): Promise<boolean>;
  /**
   * Asks the planner of the parent, in the parent's own chat, the open questions of a subtask run, and sends the run
   * the answer through the Answer command. Returns the answer. When the planner gives none, the run is told to decide
   * itself and the result is null.
   */
  abstract answer(opened: OpenedStep, child: RunEntity, task: Subtask, contract: string): Promise<string | null>;
}
