import type { RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';
import type { OpenedStep } from '../step-run';
import type { Need } from './needs';

/** One merge request of a subtask: the repository it is for, and where the host has it. */
export interface SubtaskMergeRequest {
  repo: string;
  project: string;
  iid: number;
}

/** What moved the feature branch under a subtask: the commit it moved to, and the words that say why the task was rebased. */
export interface RebaseEvent {
  tip: string;
  note: string;
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
  /**
   * Records the merge outcome of a done subtask run whose requests the parent merged, so the run reads merged at once,
   * and the files its merge changed.
   */
  abstract recordMerged(parent: RunEntity, run: RunEntity, merged: Record<string, string>): Promise<void>;
  /** Moves the worktrees of the parent to the feature branch as it is on origin. */
  abstract fastForward(parent: RunEntity): Promise<void>;
  /**
   * Moves a subtask run onto the feature branch, when it has a merge request and is in a state that takes it. A run
   * that works takes it when its current step ends, and a run that waits for a person or a sibling is left alone.
   * With `event` the move and its note are one for that event. True when the run was sent the rebase or will take it.
   */
  abstract rebase(run: RunEntity, event?: RebaseEvent): Promise<boolean>;
  /** The tip of the feature branch when the head of a subtask run, and so its last CI, does not contain it; null when it does. */
  abstract behindTip(parent: RunEntity, run: RunEntity): Promise<string | null>;
  /** The files in which the head of a subtask run conflicts with the feature branch. Empty when git names none. */
  abstract conflictFiles(parent: RunEntity, run: RunEntity): Promise<string[]>;
  /** True when the run waits in research for answers to its questions. */
  abstract asking(run: RunEntity): Promise<boolean>;
  /**
   * Asks the planner of the parent, in the parent's own chat, the open questions of a subtask run, and sends the run
   * the answer through the Answer command. Returns the answer. When the planner gives none, the run is told to decide
   * itself and the result is null.
   */
  abstract answer(opened: OpenedStep, child: RunEntity, task: Subtask, contract: string): Promise<string | null>;
  /** The needs a subtask run ended its step with: the sibling tasks it waits for. None when it asked for nothing. */
  abstract needsOf(run: RunEntity): Promise<Need[]>;
  /** The merge request text of a subtask run, or an empty string. */
  abstract mergeSummary(run: RunEntity): Promise<string>;
  /** Brings the worktrees of a subtask run, edits that are not committed included, up to the feature branch as it is on origin. */
  abstract catchUp(parent: RunEntity, run: RunEntity): Promise<void>;
  /**
   * Ends the wait of a subtask run that asked for needs: the needs are cleared, the lines go into its handoff, and the
   * step that asked runs again in its chat.
   */
  abstract rerun(run: RunEntity, lines: string[]): Promise<void>;
  /** Asks the planner of the parent, in the parent's own chat, a question about a task. Null when it gave no usable answer. */
  abstract askAbout(opened: OpenedStep, task: Subtask, question: string, contract: string): Promise<string | null>;
}
