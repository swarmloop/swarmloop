import type { RunEntity } from '../../history/entities';
import type { RunSummary } from '../../contract/api';
import { parseSubtasks, shownTaskState, SUBTASKS_KIND, type Subtask, type SubtaskStatus } from '../../contract/subtask';
import { ownStates, type OwnState, type StateSources } from './own-state';

type ListState = Pick<RunSummary, 'state' | 'stateReason' | 'task' | 'taskCounts'>;

/** What `list()` has read of the runs before the states are worked out. */
interface ListFacts {
  /** The key of each run, by id. */
  keys: Map<number, string>;
  /** The subtask runs of each parent, by parent id. */
  childrenOf: Map<number, RunEntity[]>;
  /** The tasks of each plan, by the key of the run that holds it. */
  plans: Map<string, Subtask[]>;
}

/** The tasks of the latest plan of every run that can hold one: each parent and each run that is not done, by run key. */
export async function listPlans(
  documents: StateSources['documents'],
  runs: RunEntity[],
  childrenOf: Map<number, RunEntity[]>,
): Promise<Map<string, Subtask[]>> {
  const holders = runs.filter((run) => run.status !== 'done' || childrenOf.has(run.id));
  const found = await documents.latestDocuments(
    holders.map((run) => run.id),
    [SUBTASKS_KIND],
  );
  const bodies = new Map(found.map((document) => [document.runId, document.body]));
  return new Map(holders.map((run) => [run.key, parseSubtasks(bodies.get(run.id) ?? null)]));
}

function taskOf(run: RunEntity, own: OwnState, plan: Subtask[] | undefined): Pick<RunSummary, 'task'> {
  const index = plan?.findIndex((task) => task.id === run.taskId) ?? -1;
  const task = plan?.[index];
  if (!task) return {};
  return { task: { index, status: shownTaskState(task, { state: own.state, currentStep: run.currentStep }) } };
}

function countsOf(
  plan: Subtask[],
  children: RunEntity[],
  states: Map<string, OwnState>,
): Pick<RunSummary, 'taskCounts'> {
  const statuses = plan.map((task) => {
    const child = [...children].reverse().find((run) => run.taskId === task.id);
    const own = child ? states.get(child.key) : undefined;
    return shownTaskState(task, child && own ? { state: own.state, currentStep: child.currentStep } : undefined);
  });
  const counts = new Map<SubtaskStatus, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return { taskCounts: Object.fromEntries(counts) };
}

/** The derived state of every run, its place in its parent's plan, and the task counts of every run with a plan, by run key. */
export async function listStates(
  documents: StateSources['documents'],
  checkouts: StateSources['checkouts'],
  runs: RunEntity[],
  { keys, childrenOf, plans }: ListFacts,
  claimed: (key: string) => boolean,
): Promise<Record<string, ListState>> {
  const states = await ownStates({ documents, checkouts }, runs, claimed);
  const result: Record<string, ListState> = {};
  for (const run of runs) {
    const own = states.get(run.key) as OwnState;
    const parentKey = typeof run.parentRunId === 'number' ? keys.get(run.parentRunId) : undefined;
    const ownPlan = plans.get(run.key);
    result[run.key] = {
      ...own,
      ...taskOf(run, own, plans.get(parentKey ?? '')),
      ...(ownPlan && ownPlan.length > 0 ? countsOf(ownPlan, childrenOf.get(run.id) ?? [], states) : {}),
    };
  }
  return result;
}
