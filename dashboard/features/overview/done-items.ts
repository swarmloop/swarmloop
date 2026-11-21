import type { Route } from 'next';
import type { RunSummary } from '@contract/api';
import type { BacklogView } from '@contract/backlog';
import { nested } from '@contract/run-list';
import { backlogPath } from '../../lib/backlog-path';

export const DONE_SHOWN = 5;

export interface DoneItem {
  key: string;
  title: string;
  href: Route;
  /** The finished run that tells the outcome: the run itself, or the latest finished run of a milestone. */
  run: RunSummary;
  /** The runs whose returns are counted; the first of a run's own line also holds its merge request. */
  runKeys: string[];
  finishedAt: number;
  durationMs: number;
  usd: number;
  /** True for a milestone: it has no single merge request. */
  milestone: boolean;
}

/** When a finished run ended: its merge or its close; else its start plus its wall clock. Later activity does not move it. */
function finishedAt(run: RunSummary): number {
  const merge = run.merge;
  if (merge && 'closed' in merge) {
    return Date.parse(merge.closed.at);
  }
  if (merge) {
    return Math.max(...Object.values(merge.merged).map((fact) => Date.parse(fact.at)));
  }
  return Date.parse(run.createdAt) + run.durationMs;
}

function runItem(run: RunSummary): DoneItem {
  const totals = run.epic ?? run;
  return {
    key: run.key,
    title: run.title,
    href: `/runs/${encodeURIComponent(run.key)}` as Route,
    run,
    runKeys: [run.key],
    finishedAt: finishedAt(run),
    durationMs: totals.durationMs,
    usd: totals.usd,
    milestone: false,
  };
}

function milestoneItems(backlog: BacklogView, rows: Map<string, RunSummary>): DoneItem[] {
  return backlog.milestones
    .filter((milestone) => milestone.status === 'accepted')
    .flatMap((milestone) => {
      const keys = new Set(
        backlog.tasks.filter((task) => task.milestone === milestone.number).flatMap((task) => task.runKey ?? []),
      );
      const runs = [...keys].flatMap((key) => rows.get(key) ?? []);
      if (runs.length === 0) {
        return [];
      }
      const ends = runs.map(finishedAt);
      const last = runs[ends.indexOf(Math.max(...ends))];
      const start = Math.min(...runs.map((run) => Date.parse(run.createdAt)));
      return {
        key: `${backlog.name}/${milestone.number}`,
        title: milestone.title,
        href: backlogPath(backlog.name),
        run: last,
        runKeys: runs.map((run) => run.key),
        finishedAt: Math.max(...ends),
        durationMs: Math.max(...ends) - start,
        usd: runs.reduce((sum, run) => sum + (run.epic ?? run).usd, 0),
        milestone: true,
      };
    });
}

/**
 * The latest finished top-level items: runs, epics and accepted milestones, the newest finish first and in list order on a tie.
 * A run that a milestone holds shows in its milestone's line only.
 */
export function doneItems(done: RunSummary[], backlogs: BacklogView[]): DoneItem[] {
  const rows = new Map(done.map((run) => [run.key, run]));
  const own = nested(done).tops.filter((run) => !run.backlog || run.backlog.milestone === null);
  return [...own.map(runItem), ...backlogs.flatMap((backlog) => milestoneItems(backlog, rows))]
    .sort((left, right) => right.finishedAt - left.finishedAt)
    .slice(0, DONE_SHOWN);
}
