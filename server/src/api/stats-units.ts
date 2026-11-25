import type { RunOutcome, StatsDay, StatsUnit } from '../contract/api';
import type { StatsRunRow } from '../history/stats.repository';
import { round } from './stats-groups';
import { localDay } from './local-day';

/** One run for the statistics: the run and the ids whose spend and returns are its own, itself first. */
interface Unit {
  run: StatsRunRow;
  ids: number[];
}

/** What a unit's figures are read from: spend, returns and working time by run id, and the days to count on. */
interface UnitReads {
  usdOf: (id: number) => number;
  returnsOf: (id: number) => number;
  workMsOf: (id: number) => number;
  days: Map<string, StatsDay>;
  tzOffset: number;
}

/** How a run ended up, from its status: done, failed (failed, blocked) or still active. */
export function outcomeOf(status: string): RunOutcome {
  if (status === 'done') {
    return 'done';
  }
  return status === 'failed' || status === 'blocked' ? 'failed' : 'active';
}

/**
 * The rows the statistics count: the runs without a parent, in the order they came in. Each one carries its own id and
 * the ids of its subtasks, whatever their state. A subtask whose parent is not in the rows is not counted.
 */
export function countedRunsOf(runs: StatsRunRow[]): { run: StatsRunRow; ids: number[] }[] {
  const children = new Map<number, number[]>();
  for (const run of runs) {
    const parent = run.parentRunId ?? null;
    if (parent !== null) {
      children.set(parent, [...(children.get(parent) ?? []), run.id]);
    }
  }
  return runs
    .filter((run) => (run.parentRunId ?? null) === null)
    .map((run) => ({ run, ids: [run.id, ...(children.get(run.id) ?? [])] }));
}

/** One per-id number added over the ids of a counted run. */
export function sumOver(ids: number[], of: (id: number) => number): number {
  return ids.reduce((sum, id) => sum + of(id), 0);
}

function exactMedian(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The median in whole numbers. */
export function median(values: number[]): number | null {
  const exact = exactMedian(values);
  return exact === null ? null : Math.round(exact);
}

/** The runs that have subtasks. Their ids carry the subtasks', so an epic's cost and returns are the sum. */
function epicsOf(runs: StatsRunRow[]): Unit[] {
  return countedRunsOf(runs).filter(({ ids }) => ids.length > 1);
}

/**
 * The runs without subtasks: a run that worked alone and each subtask of a counted run. A run whose stored state is
 * `skipped` (f123) is in none: it ended without being done or failed. Its spend stays in its epic's ids.
 */
function tasksOf(runs: StatsRunRow[]): Unit[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  return countedRunsOf(runs)
    .flatMap(({ run, ids }) => (ids.length === 1 ? [run] : ids.slice(1).flatMap((id) => byId.get(id) ?? [])))
    .filter((run) => run.state !== 'skipped')
    .map((run) => ({ run, ids: [run.id] }));
}

/** The tasks that are subtasks, as rows: what a day of the tasks chart opens besides the runs that worked alone. */
export function subtaskTasksOf(runs: StatsRunRow[]): StatsRunRow[] {
  return tasksOf(runs)
    .map(({ run }) => run)
    .filter((run) => (run.parentRunId ?? null) !== null);
}

function epicMs(unit: Unit): number | null {
  const ms = Date.parse(unit.run.doneAt ?? '') - Date.parse(unit.run.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The figures of one kind of unit, and the units counted by the day they started. Time and returns are of finished ones. */
function figuresOf(
  units: Unit[],
  reads: UnitReads,
  timeOf: (unit: Unit) => number | null,
  perDay: 'epics' | 'tasks',
): StatsUnit {
  const counts = { done: 0, active: 0, failed: 0 };
  for (const unit of units) {
    const outcome = outcomeOf(unit.run.status);
    counts[outcome] += 1;
    const day = reads.days.get(localDay(unit.run.createdAt, reads.tzOffset));
    if (day) {
      day[perDay][outcome] += 1;
    }
  }
  const finished = units.filter(({ run }) => outcomeOf(run.status) === 'done');
  const returns = finished.map(({ ids }) => sumOver(ids, reads.returnsOf));
  return {
    finished: counts.done,
    active: counts.active,
    failed: counts.failed,
    medianUsd: round(exactMedian(finished.map(({ ids }) => sumOver(ids, reads.usdOf))) ?? 0),
    medianMs: median(finished.map(timeOf).filter((ms): ms is number => ms !== null && ms > 0)),
    back: returns.filter((count) => count > 0).length,
    medianReturns: median(returns),
  };
}

/** Epics and tasks, each counted once, and the day counts of each. */
export function unitsOf(runs: StatsRunRow[], reads: UnitReads): { epics: StatsUnit; tasks: StatsUnit } {
  return {
    epics: figuresOf(epicsOf(runs), reads, epicMs, 'epics'),
    tasks: figuresOf(tasksOf(runs), reads, ({ ids }) => reads.workMsOf(ids[0]), 'tasks'),
  };
}
