import type { RunKind } from '../contract/eta';
import type { RunState, StateReason, SubtaskStatus } from '../contract/run-state';

/** A stretch the run was not working on its own. `to` is null while the stretch is open. Times are ISO 8601. */
export interface Wait {
  from: string;
  to: string | null;
}

/** What the estimator learns from one run: its times, its step entries and its waits. */
export interface FinishedRunInput {
  createdAt: string;
  lastFinishedAt: string | null;
  mergedAt: string | null;
  parentRunId: string | null;
  epicAt: string | null;
  /** Every entry into a step, in any order; a step entered again appears again. */
  entries: { step: string; startedAt: string }[];
  waits: Wait[];
}

/** One number per step, and the median of a whole run, for one kind of run. */
export interface KindNumbers {
  steps: Record<string, number>;
  whole: number | null;
}

export type EtaTable = Record<RunKind, KindNumbers>;

/** A run that has not ended, as the estimate reads it. */
export interface LiveRun {
  kind: RunKind;
  state: RunState;
  reason: StateReason | null;
  currentStep: string;
  stepStartedAt: string | null;
  waits: Wait[];
}

/** One task of an epic: its status, its dependencies and its own run once it has started. */
export interface TaskInput {
  id: string;
  status: SubtaskStatus;
  depends: string[];
  run?: LiveRun;
}
