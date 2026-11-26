import type { RunSummary } from '../contract/api';
import { DONE_SHOWN, type AcceptedMilestone, type DoneLatelyItem } from '../contract/overview-done';
import { filterRuns, nested } from '../contract/run-list';

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

function runItem(run: RunSummary): DoneLatelyItem {
  const totals = run.epic ?? run;
  return {
    key: run.key,
    title: run.title,
    link: { run: run.key },
    run,
    runKeys: [run.key],
    finishedAt: finishedAt(run),
    durationMs: totals.durationMs,
    usd: totals.usd,
    milestone: false,
  };
}

function milestoneItem(milestone: AcceptedMilestone, rows: Map<string, RunSummary>): DoneLatelyItem[] {
  const keys = new Set(milestone.runKeys);
  const runs = [...keys].flatMap((key) => rows.get(key) ?? []);
  if (runs.length === 0) {
    return [];
  }
  const ends = runs.map(finishedAt);
  const last = runs[ends.indexOf(Math.max(...ends))];
  const start = Math.min(...runs.map((run) => Date.parse(run.createdAt)));
  return [
    {
      key: `${milestone.backlog}/${milestone.number}`,
      title: milestone.title,
      link: { backlog: milestone.backlog },
      run: last,
      runKeys: runs.map((run) => run.key),
      finishedAt: Math.max(...ends),
      durationMs: Math.max(...ends) - start,
      usd: runs.reduce((sum, run) => sum + (run.epic ?? run).usd, 0),
      milestone: true,
    },
  ];
}

/**
 * The latest finished top-level items: runs, epics and accepted milestones, the newest finish first and in list order on a tie.
 * A run that a milestone holds shows in its milestone's line only.
 */
export function doneItems(runs: RunSummary[], milestones: AcceptedMilestone[]): DoneLatelyItem[] {
  const done = filterRuns(runs, '', 'done').visible;
  const rows = new Map(done.map((run) => [run.key, run]));
  const own = nested(done).tops.filter((run) => !run.backlog || run.backlog.milestone === null);
  return [...own.map(runItem), ...milestones.flatMap((milestone) => milestoneItem(milestone, rows))]
    .sort((left, right) => right.finishedAt - left.finishedAt)
    .slice(0, DONE_SHOWN);
}
