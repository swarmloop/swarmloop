import type { Route } from 'next';
import type { RunSummary } from '@contract/api';
import type { BacklogView } from '@contract/backlog';
import type { RunEta } from '@contract/eta';
import { milestoneWork } from '@contract/milestone-work';
import { nested } from '@contract/run-list';
import { PHASES } from '@contract/steps';
import { settled } from '@contract/subtask';
import { backlogPath } from '../../lib/backlog-path';
import { phaseLabel } from '../../lib/phase-label';
import { phaseOf, runWord } from '../run';

const NOW_SHOWN = 6;

export interface NowCard {
  id: string;
  title: string;
  href: Route;
  /** Tasks settled (merged or skipped) and in all, for a milestone or an epic. */
  tasks?: { settled: number; total: number };
  /** A milestone whose work is done and that waits for its acceptance. */
  workDone?: boolean;
  /** The step a run is at, in words, and how far along the flow it is (0 to 100). */
  step?: { label: string; percent: number };
  run?: RunSummary;
  /** A milestone's estimate: none while a task has no estimate of its own yet. */
  milestoneEta?: RunEta | null;
}

type Task = BacklogView['tasks'][number];

/**
 * When a milestone should be done: the latest estimate of its unfinished tasks. A task that has no run yet, such as one that
 * waits for a task it depends on, or whose run has no time to give, makes the whole estimate unknown.
 */
function milestoneEta(tasks: Task[], runs: Map<string, RunSummary>, now: number): RunEta | null {
  let left = 0;
  for (const task of tasks.filter((item) => !settled(item))) {
    const eta = task.runKey === null ? undefined : runs.get(task.runKey)?.eta;
    if (!eta || eta.leftMs === null) {
      return null;
    }
    left = Math.max(left, eta.leftMs);
  }
  return { leftMs: left, doneAt: new Date(now + left).toISOString() };
}

function runCard(run: RunSummary): NowCard {
  const counts = run.taskCounts;
  const total = Object.values(counts ?? {}).reduce((sum, value) => sum + value, 0);
  const phase = phaseOf(run.currentStep);
  return {
    id: run.key,
    title: run.title,
    href: `/runs/${encodeURIComponent(run.key)}` as Route,
    run,
    ...(counts
      ? { tasks: { settled: (counts.merged ?? 0) + (counts.skipped ?? 0), total } }
      : { step: { label: phaseLabel(phase), percent: ((PHASES.indexOf(phase) + 1) / PHASES.length) * 100 } }),
  };
}

/** What works now: active milestones, then top-level runs and epics that move by themselves; at most six. */
export function nowCards(backlogs: BacklogView[], active: RunSummary[], now: number): NowCard[] {
  const runs = new Map(active.map((run) => [run.key, run]));
  const milestones: NowCard[] = backlogs.flatMap((backlog) =>
    backlog.milestones
      .filter((milestone) => milestone.status === 'active')
      .map((milestone) => {
        const tasks = backlog.tasks.filter((task) => task.milestone === milestone.number);
        const work = milestoneWork(backlog, milestone.number);
        return {
          id: `${backlog.name}/${milestone.number}`,
          title: milestone.title,
          href: backlogPath(backlog.name),
          tasks: { settled: work.settled, total: work.total },
          workDone: work.done,
          milestoneEta: milestoneEta(tasks, runs, now),
        };
      }),
  );
  const working = nested(active)
    .tops.filter((run) => (!run.backlog || run.backlog.milestone === null) && runWord(run).tone === 'working')
    .map(runCard);
  return [...milestones, ...working].slice(0, NOW_SHOWN);
}
