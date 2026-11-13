/** How a run ended up, for the statistics: done, still going (running, waiting, stopped), or failed (failed, blocked). */
export type RunOutcome = 'done' | 'active' | 'failed';

/** One local day of the statistics range. Runs count by the day they started; spend and returns by the day they happened. */
export interface StatsDay {
  day: string;
  done: number;
  active: number;
  failed: number;
  usd: number;
  returns: number;
  /** Done runs of the day that were merged, and that were closed without a merge. Both are also in `done`. */
  merged: number;
  closed: number;
  /** Median time from done to merge of the day's merged runs; null without one. */
  medianToMergeMs: number | null;
}

/** Spend and tokens of one step, model, effort or agent. `count` is visits for steps, models and efforts, runs for agents. */
export interface StatsShare {
  name: string;
  usd: number;
  tokens: number;
  count: number;
}

export interface StatsRun {
  key: string;
  name: string;
  status: string;
  outcome: RunOutcome;
  usd: number;
  returns: number;
  /** Bash tool calls of the run that changed files through a script or `sed -i`. */
  shellEdits: number;
  durationMs: number;
  createdAt: string;
}

/** One source of returns. A `checks` reason lists the commands that failed most. */
export interface StatsReason {
  name: string;
  returns: number;
  commands?: { name: string; returns: number }[];
}

/** `only`: CI failed where the checks had passed, with the jobs that did it. `withChecks`: the rest. */
export interface StatsCiReturns {
  only: number;
  withChecks: number;
  jobs: { name: string; returns: number }[];
}

export interface StatsTotals {
  runs: number;
  done: number;
  active: number;
  failed: number;
  usd: number;
  tokensIn: number;
  tokensOut: number;
  /** Times a reviewer sent the work back to implementation. */
  reviewReturns: number;
  /** Every return by the loop counter that sent it back (`checks`, `review`, `pipeline`, ...), most first. */
  returnsByKind: { kind: string; returns: number }[];
  /** Tasks: done runs with no parent. A split run is one task with its subtasks. */
  tasks: number;
  /** Mean and median spend of a task. */
  usdPerTask: number;
  medianUsdPerTask: number;
  /** Tasks that came back at least once, and the median of returns per task; null without a task. */
  tasksBack: number;
  medianReturnsPerTask: number | null;
  /** Times the CI pipeline sent the work back. */
  pipelineReturns: number;
  /** Done runs that never went back. */
  firstPass: number;
  /** Launches that ended on a provider usage limit. A limited launch is no attempt of its step. */
  limits: number;
  /** Time the agents worked, summed over steps. */
  agentMs: number;
  /** Median working time of a done run; null without one. */
  medianDoneMs: number | null;
  /** Done runs whose merge requests were merged, and whose were closed without a merge. Both are also in `done`. */
  merged: number;
  closed: number;
  /** Median time from done to merge of the merged runs; null without one. */
  medianToMergeMs: number | null;
}

/** The runs started from `from` to `to` (local days, inclusive) and everything they did. */
export interface StatsView {
  from: string;
  to: string;
  totals: StatsTotals;
  days: StatsDay[];
  steps: StatsShare[];
  models: StatsShare[];
  /** Spend by the effort the visit ran with; a visit that named none is under `runtime default`. */
  efforts: StatsShare[];
  agents: StatsShare[];
  /** Who sent work back: one reviewer per entry, and `pipeline` for CI. */
  reasons: StatsReason[];
  /** Pipeline returns split by whether the checks of the same content had passed. */
  ciReturns: StatsCiReturns;
  /** How many runs went back 0, 1, 2, 3 and 4 or more times. */
  returnsPerRun: { returns: string; runs: number }[];
  /** Every run of the range, newest first. */
  runs: StatsRun[];
}
