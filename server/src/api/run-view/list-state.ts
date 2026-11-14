import type { RunEntity } from '../../history/entities';
import type { DocumentRepository } from '../../history/document.repository';
import type { CheckoutRepository } from '../../history/checkout.repository';
import type { RunSummary } from '../../contract/api';
import { parseSubtasks, shownTaskState, SUBTASKS_KIND, type Subtask, type SubtaskStatus } from '../../contract/subtask';
import { openItems, stateView } from './flow';

type ListState = Pick<RunSummary, 'state' | 'stateReason' | 'task' | 'taskCounts'>;
type OwnState = Pick<RunSummary, 'state' | 'stateReason'>;
type Documents = Pick<DocumentRepository, 'listDocuments' | 'latestBody'>;
type Pastes = Pick<CheckoutRepository, 'listPastes'>;

/** The state of one run as the run page shows it, without the facts of pending commands. */
async function ownState(
  documents: Documents,
  checkouts: Pastes,
  run: RunEntity,
  claimed: (key: string) => boolean,
): Promise<OwnState> {
  const shown = claimed(run.key) && run.status !== 'done' ? { ...run, status: 'running' } : run;
  const needsFacts = shown.status === 'waiting' || shown.status === 'blocked';
  const docs = needsFacts ? await documents.listDocuments(run.id) : [];
  const pastes = needsFacts ? await checkouts.listPastes(run.key) : [];
  const open = openItems(
    shown,
    docs,
    pastes.map((paste) => paste.url),
  );
  const view = stateView(shown, open, docs);
  return { state: view.state, stateReason: view.reason };
}

/** The tasks of each parent's latest plan, by parent key, read once per parent. */
async function plans(documents: Documents, parentKeys: string[]): Promise<Map<string, Subtask[]>> {
  const parsed = new Map<string, Subtask[]>();
  for (const key of parentKeys) {
    parsed.set(key, parseSubtasks(await documents.latestBody(key, SUBTASKS_KIND)));
  }
  return parsed;
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
  documents: Documents,
  checkouts: Pastes,
  runs: RunEntity[],
  keys: Map<number, string>,
  claimed: (key: string) => boolean,
): Promise<Record<string, ListState>> {
  const states = new Map<string, OwnState>();
  for (const run of runs) {
    states.set(run.key, await ownState(documents, checkouts, run, claimed));
  }
  const parentKey = (run: RunEntity): string | undefined =>
    typeof run.parentRunId === 'number' ? keys.get(run.parentRunId) : undefined;
  // A finished run that is nobody's parent has no plan to count, so its document is not read.
  const parents = new Set(runs.flatMap((run) => parentKey(run) ?? []));
  const planKeys = new Set([...parents, ...runs.filter((run) => run.status !== 'done').map((run) => run.key)]);
  const parsed = await plans(documents, [...planKeys]);
  const result: Record<string, ListState> = {};
  for (const run of runs) {
    const own = states.get(run.key) as OwnState;
    const plan = parsed.get(parentKey(run) ?? '');
    const children = runs.filter((child) => parentKey(child) === run.key);
    const ownPlan = parsed.get(run.key);
    result[run.key] = {
      ...own,
      ...taskOf(run, own, plan),
      ...(ownPlan && ownPlan.length > 0 ? countsOf(ownPlan, children, states) : {}),
    };
  }
  return result;
}
