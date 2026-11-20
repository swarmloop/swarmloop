import { ETA_MIN_MS } from '../contract/eta';
import type { RunEta } from '../contract/eta';
import { STEPS } from '../contract/steps';
import type { EtaTable, LiveRun, TaskInput } from './eta.types';
import { etaAfter, runEta } from './run-eta';
import { SEED_RUN_MS, seedFor } from './seed';

/** Each remaining task's time left; null when a task waits for a person. */
function taskLefts(tasks: readonly TaskInput[], table: EtaTable, now: string): Map<string, number> | null {
  const lefts = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === 'blocked') {
      return null;
    }
    if (task.status === 'green') {
      lefts.set(task.id, 0);
    } else if (task.run) {
      const eta = runEta(task.run, table, now);
      if (eta === null) {
        return null;
      }
      lefts.set(task.id, eta?.leftMs ?? 0);
    } else {
      lefts.set(task.id, table.subtask.whole ?? SEED_RUN_MS);
    }
  }
  return lefts;
}

function longestChain(tasks: readonly TaskInput[], lefts: Map<string, number>): number {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const done = new Map<string, number>();
  const open = new Set<string>();
  const chainTo = (id: string): number => {
    const known = done.get(id);
    const task = byId.get(id);
    if (known !== undefined || !task || open.has(id)) {
      return known ?? 0;
    }
    open.add(id);
    const before = Math.max(0, ...task.depends.map(chainTo));
    open.delete(id);
    const total = before + (lefts.get(id) ?? 0);
    done.set(id, total);
    return total;
  };
  return Math.max(0, ...tasks.map((task) => chainTo(task.id)));
}

function nextStepNumber(parent: LiveRun, table: EtaTable): number {
  const index = (STEPS as readonly string[]).indexOf(parent.currentStep);
  if (index === STEPS.length - 1) {
    return 0;
  }
  const next = index < 0 ? undefined : STEPS[index + 1];
  if (next === undefined) {
    return seedFor(parent.currentStep);
  }
  return table.epic.steps[next] ?? seedFor(next);
}

/** The estimate of an epic parent: the longer of its longest chain and its load over `parallel`, plus the parent's next step. */
export function epicEta(
  parent: LiveRun,
  tasks: readonly TaskInput[],
  table: EtaTable,
  parallel: number,
  now: string,
): RunEta | null | undefined {
  const own = runEta(parent, table, now);
  const remaining = tasks.filter((task) => task.status !== 'merged' && task.status !== 'skipped');
  if (!own || remaining.length === 0) {
    return own;
  }
  const lefts = taskLefts(remaining, table, now);
  if (lefts === null) {
    return null;
  }
  const load = [...lefts.values()].reduce((sum, left) => sum + left, 0) / Math.max(1, parallel);
  const left = Math.max(longestChain(remaining, lefts), load) + nextStepNumber(parent, table);
  return etaAfter(Math.max(ETA_MIN_MS, left), now);
}
