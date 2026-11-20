import type { Requirement } from '../../contract/requirement-list';
import type { Subtask } from '../../contract/subtask';
import type { StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import { planItemsFromTasks, withAddedTasks, withDecisions } from '../plan/plan-tasks';
import { withDecision } from '../shared/handoff';
import type { Need } from '../shared/needs';
import { coverageProblems } from '../shared/requirement-coverage';
import { refusal } from './need-refusal';

/** What the actions of an answer act on: the contract and the task list of the parent, and the task that asked. */
export interface StarterState {
  contract: string;
  tasks: Subtask[];
  requirements: Requirement[];
  asker: string;
}

/** The part of the state that the task list and the requirements give. */
export type StarterPlan = Pick<StarterState, 'tasks' | 'requirements'>;

/** One change of the task list with its reason, as the plan items of the task before and after it. */
export interface PlanChange {
  taskId: string;
  reason: string;
  before: string[];
  after: string[];
}

/** What an answer did: the refusals, or the new contract and tasks, the tasks the asker waits for, and the plan changes. */
interface AppliedAnswer {
  errors: string[];
  contract: string;
  tasks: Subtask[];
  waitFor: Need[];
  changes: PlanChange[];
}

/** The statuses of a task that has not started: only these may be changed or dropped. */
export const NOT_STARTED = ['waiting', 'pending'];

const lineOf = (task: Subtask): string => planItemsFromTasks([task])[0];

/** What is wrong with the decision of an answer, and with actions where the answer may not act. */
export function decisionErrors(answer: StarterAnswerResult, mayAct: boolean): string[] {
  const acts = answer.waitFor?.length || answer.addTask?.length || answer.changeTask?.length || answer.dropTask?.length;
  return [
    ...(answer.decision.trim() ? [] : ['decision: give the decision']),
    ...(acts && !mayAct ? ['actions are not allowed here: send the decision only'] : []),
  ];
}

/** The refusals of the changes and drops: a task that does not exist or has started, and a change with no reason. */
function changeErrors(tasks: Subtask[], answer: StarterAnswerResult): string[] {
  const changes = [
    ...(answer.changeTask ?? []).map(({ id, reason }) => ({ id, reason, verb: 'changeTask' })),
    ...(answer.dropTask ?? []).map(({ id, reason }) => ({ id, reason, verb: 'dropTask' })),
  ];
  return changes.flatMap(({ id, reason, verb }) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return [`${verb}: no task has the id ${id}`];
    if (!NOT_STARTED.includes(task.status)) {
      return [`${id} has started: changeTask and dropTask only for tasks that have not started`];
    }
    return reason.trim() ? [] : [`${verb} ${id}: say why`];
  });
}

/** The task list after the changes and drops of the answer, and one plan change for each. */
function changedTasks(tasks: Subtask[], answer: StarterAnswerResult): { tasks: Subtask[]; changes: PlanChange[] } {
  const changes: PlanChange[] = [];
  const changed = tasks.map((task) => {
    const change = answer.changeTask?.find((item) => item.id === task.id);
    if (!change) return task;
    const { id, reason, ...fields } = change;
    const next = { ...task, ...fields };
    changes.push({ taskId: id, reason, before: [lineOf(task)], after: [lineOf(next)] });
    return next;
  });
  const dropped = answer.dropTask ?? [];
  for (const { id, reason } of dropped) {
    changes.push({ taskId: id, reason, before: [lineOf(tasks.find((task) => task.id === id) as Subtask)], after: [] });
  }
  return { tasks: changed.filter((task) => !dropped.some((drop) => drop.id === task.id)), changes };
}

/**
 * What an answer of the planner does to the parent: its decision goes into the contract with its time, tasks are
 * added at the end, tasks that have not started are changed or dropped, and `waitFor` names the tasks the asker waits
 * for. `source` says who asked for the tasks that are added. Every change is checked as the planner's own plan is. With any refusal nothing but the decision is applied.
 */
export function applyStarterAnswer(
  state: StarterState,
  answer: StarterAnswerResult,
  at: string,
  source = `Subtask ${state.asker} asked for it`,
): AppliedAnswer {
  const decided = withDecision(state.contract, state.asker, answer.decision, at);
  const refused = (errors: string[]): AppliedAnswer => ({
    errors,
    contract: decided,
    tasks: state.tasks,
    waitFor: [],
    changes: [],
  });
  const early = [...decisionErrors(answer, true), ...changeErrors(state.tasks, answer)];
  if (early.length > 0) return refused(early);
  const changed = changedTasks(state.tasks, answer);
  const limits = { maySplit: true, maxTasks: Number.POSITIVE_INFINITY };
  const stored = { contract: state.contract, tasks: changed.tasks, keep: [] };
  const added = answer.addTask ?? [];
  const { graph, errors } = withAddedTasks(stored, { contract: [], tasks: added, keep: [] }, limits);
  if (!graph) return refused(errors);
  const touched = added.length + changed.changes.length > 0;
  const units = graph.tasks.map((task) => ({ item: lineOf(task), covers: task.covers ?? [] }));
  const uncovered = touched && state.requirements.length > 0 ? coverageProblems(state.requirements, units) : [];
  const waits = (answer.waitFor ?? []).flatMap((need) => {
    const asker = graph.tasks.find((task) => task.id === state.asker);
    const reason = asker ? refusal(asker, need, graph.tasks) : `no task has the id ${state.asker}`;
    return reason ? [`waitFor: ${need.id}: ${reason}`] : [];
  });
  if (uncovered.length + waits.length > 0) return refused([...uncovered, ...waits]);
  const reason = `${source}: ${answer.decision.trim()}`;
  const appended = graph.tasks.slice(stored.tasks.length);
  return {
    errors: [],
    contract: withDecisions(decided, graph.decisions),
    tasks: graph.tasks,
    waitFor: answer.waitFor ?? [],
    changes: [
      ...changed.changes,
      ...appended.map((task) => ({ taskId: task.id, reason, before: [], after: [lineOf(task)] })),
    ],
  };
}
