import type { RunSummary } from './api';

/** How many items Done lately shows. */
export const DONE_SHOWN = 5;

/** One line of Done lately: a finished run, an epic, or an accepted milestone. */
export interface DoneLatelyItem {
  /** The run key, or `${backlog}/${milestone number}` for a milestone. */
  key: string;
  title: string;
  /** What the line opens: a run, or the backlog of a milestone. */
  link: { run: string } | { backlog: string };
  /** The finished run that tells the outcome: the run itself, or the latest finished run of a milestone. */
  run: RunSummary;
  /** The runs whose returns are counted; a run's own line holds its own key first. */
  runKeys: string[];
  /** Milliseconds since the epoch. */
  finishedAt: number;
  durationMs: number;
  usd: number;
  /** True for a milestone: it has no single merge request. */
  milestone: boolean;
}

/** An accepted milestone of a backlog and the run keys of its tasks. */
export interface AcceptedMilestone {
  backlog: string;
  number: number;
  title: string;
  runKeys: string[];
}
