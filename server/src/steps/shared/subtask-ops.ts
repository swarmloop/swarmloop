import type { RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';
import type { OpenedStep } from '../step-run';
import type { Need } from './needs';
import type { StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import type { LookStart } from './look-start';
import type { PlanChange, StarterPlan } from '../implement/starter-actions';

/** Who starts a step again: a person, a planner of some level, or the machine. */
export interface SubtaskStart {
  by: 'person' | 'planner' | 'machine';
  level: number | null;
}

/** The question a run puts up the planners' chain: the step it comes from and its text. */
export interface ChainQuestion {
  from: string;
  text: string;
}

/** Who a question reached, the level of the planner that did, and its answer. No answer means it waits for the person. */
export interface ChainAsked {
  asked: 'run-planner' | 'epic-planner' | 'starter';
  level: number;
  answer: string | null;
}

/** What a planner gives instead of a decision when it cannot settle a part's question: what whoever started the run must decide. */
export interface Escalated {
  escalate: string;
}

/** True for the planner's escalation, and false for its decision: an answer with `escalate` is never read as a decision. */
export function isEscalated(answer: unknown): answer is Escalated {
  return typeof answer === 'object' && answer !== null && typeof (answer as Partial<Escalated>).escalate === 'string';
}

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

/** A task run's move onto the epic's new tip that the epic has not read yet: it is queued or running, or it failed. */
export type TaskMove = { kind: 'moving' } | { kind: 'failed'; reason: string };

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
  /**
   * Closes the run of a subtask its epic ended or skipped: it stops, reads `skipped` with `reason`, its open merge
   * requests are closed and its workspace is freed. A failure is logged and the next pass tries again.
   */
  abstract closeSkipped(parent: RunEntity, run: RunEntity, reason: string): Promise<void>;
  /** The branch of a subtask run. */
  abstract branchOf(run: RunEntity): Promise<string>;
  /**
   * Records the merge outcome of a done subtask run whose requests the parent merged, so the run reads merged at once.
   * The files its merge changed are recorded by the merge landing.
   */
  abstract recordMerged(parent: RunEntity, run: RunEntity, merged: Record<string, string>): Promise<void>;
  /**
   * Commits the uncommitted edits of the parent's worktrees onto the feature branch before a pass brings it from the
   * host. With `park` a conflict stays in the worktree as a rebase that stopped, for the implement agent to resolve.
   */
  abstract commitOwnEdits(parent: RunEntity, park: boolean): Promise<OwnEdits>;
  /**
   * Moves the worktrees of the parent to the feature branch as it is on origin. Null when they moved; otherwise the
   * words that say which worktree stayed, with both heads.
   */
  abstract fastForward(parent: RunEntity): Promise<string | null>;
  /**
   * Moves a subtask run onto the feature branch, when it has a merge request and is in a state that takes it. A run
   * that works takes it when its current step ends, and a run a person stopped is left alone. A run that waits on a
   * question or a sibling is moved and keeps its wait. With `event` the move and its note are one for that event.
   * True when the run goes on after the move: it was sent the rebase or will take it, and does not keep a wait.
   */
  abstract rebase(run: RunEntity, event?: RebaseEvent): Promise<boolean>;
  /**
   * The one read of a subtask run's move: its newest Rebase command, whoever sent it. `moving` while it is queued or
   * running, in any state of the run; `failed` with its error while the run is blocked or failed and no later command
   * replaced it. Null otherwise.
   */
  abstract moveOf(run: RunEntity): Promise<TaskMove | null>;
  /** True when a move keeps the run in its wait: it waits on a question or a sibling. */
  abstract keepsWait(run: RunEntity): Promise<boolean>;
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
   * planner gave no usable answer and nothing was sent. An escalation means it could not settle the question: it is
   * handed up with the planner's words, and nothing is sent to the run.
   */
  abstract answer(
    opened: OpenedStep,
    child: RunEntity,
    task: Subtask,
    contract: string,
    plan?: StarterPlan,
    start?: LookStart,
  ): Promise<StarterAnswerResult | Escalated | null>;
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
  /** Moves a subtask run onto the feature branch through its Rebase, keeping its state; a conflict stays parked for its implement agent. */
  abstract catchUp(parent: RunEntity, run: RunEntity): Promise<void>;
  /**
   * Ends the wait of a subtask run that asked for needs: the needs are cleared, the lines go into its handoff, and the
   * step that asked runs again in its chat, as the machine's start unless `start` says who asks. A run a person
   * stopped is left as it is: nothing is written and nothing runs, unless a person (or a planner on a person's
   * message) asks.
   */
  abstract rerun(run: RunEntity, lines: string[], start?: SubtaskStart): Promise<void>;
  /**
   * Asks the planner of the parent, in the parent's own chat, a question about a task. Null when it gave no usable
   * answer; an escalation when it could not settle the question.
   */
  abstract askAbout(
    opened: OpenedStep,
    task: Subtask,
    question: string,
    contract: string,
  ): Promise<string | Escalated | null>;
  /**
   * Puts a question of a run to the planners above it, from `startLevel` up, one level higher for each answer that
   * changed nothing. The run is never started: the caller does that, as a planner start of the returned level.
   */
  abstract askUp(run: RunEntity, question: ChainQuestion, startLevel: number): Promise<ChainAsked>;
  /** The ISO time the needs document of a subtask run was written, or null when it has none. */
  abstract needsWrittenAt(run: RunEntity): Promise<string | null>;
  /** The ISO time a task of the parent was merged or skipped, or null when it is not settled or the time is not known. */
  abstract settledAt(parent: RunEntity, taskId: string): Promise<string | null>;
}
