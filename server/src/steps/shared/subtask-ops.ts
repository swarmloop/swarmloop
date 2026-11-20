import type { RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';
import type { OpenedStep } from '../step-run';
import type { Need } from './needs';
import type { StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import type { PlanChange, StarterPlan } from '../implement/starter-actions';

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

/** What committing the own edits of a parent left: the line that names the committed paths, and the words of a conflict. */
export interface OwnEdits {
  committed: string | null;
  conflict: string | null;
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
  /** Commits the uncommitted edits of the parent's worktrees onto the feature branch before a pass brings it from the host. */
  abstract commitOwnEdits(parent: RunEntity): Promise<OwnEdits>;
  /**
   * Moves the worktrees of the parent to the feature branch as it is on origin. Null when they moved; otherwise the
   * words that say which worktree stayed, with both heads.
   */
  abstract fastForward(parent: RunEntity): Promise<string | null>;
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
   * Asks the planner of the parent, in the parent's own chat, the open questions of a subtask run. With `plan` the
   * planner may act on the task list, and a refused action goes back to it in the same visit. The run is sent the
   * decision, or, when the answer has `waitFor`, made to wait for those tasks. Returns the answer. Null means the
   * planner gave no usable answer and nothing was sent.
   */
  abstract answer(
    opened: OpenedStep,
    child: RunEntity,
    task: Subtask,
    contract: string,
    plan?: StarterPlan,
  ): Promise<StarterAnswerResult | null>;
  /** Sends a subtask run the answer again that it refused, so the planner is not asked twice. Null while it is refused. */
  abstract resend(child: RunEntity): Promise<StarterAnswerResult | null>;
  /** Writes the changes of an answer as plan revisions with their reasons, in the parent's chat and in the chat of each changed task. */
  abstract recordRevisions(parent: RunEntity, changes: PlanChange[], at: string): Promise<void>;
  /** True when the planner answered a subtask run and the delivery was refused, so `answer` sends that reply again. */
  abstract replyPending(child: RunEntity): boolean;
  /** Sends a subtask run the answer of the person to its open questions through the Answer command. */
  abstract deliverAnswer(child: RunEntity, text: string): Promise<void>;
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
