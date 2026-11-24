import Joi from 'joi';
import { defineResult } from '../result-definition';
import { planKeys } from './plan';
import type { Need } from './research';
import { list, taskSchema, type SplitTask } from './split-fields';

/** A change to a task that has not started. Only the fields that change are given. */
type TaskChange = Partial<SplitTask> & { id: string; reason: string };

/** A task that has not started and is dropped, with the reason. */
interface TaskDrop {
  id: string;
  reason: string;
}

/** What the planner of a run hands back to a run it started: a decision, and optionally the actions that follow from it. */
export interface StarterAnswerResult {
  decision: string;
  /** For a question about a reviewer's finding: whether the finding holds or is ruled out. */
  finding?: 'holds' | 'ruled-out';
  waitFor?: Need[];
  addTask?: SplitTask[];
  changeTask?: TaskChange[];
  dropTask?: TaskDrop[];
}

const reason = Joi.string().required().description('Why');

const escalate = Joi.string().description(
  'What whoever started the run must decide, when you cannot settle it. Never invent a product decision',
);

/** The schema of the answer. With `escalate` a decision is not needed; without it a decision is always required. */
function starterSchema(withEscalate: boolean): Joi.ObjectSchema {
  const decision = Joi.string().description(
    withEscalate
      ? 'The decision the task follows, written to the contract; leave out only when you escalate'
      : 'The decision the task follows, written to the contract',
  );
  return Joi.object({
    decision: withEscalate
      ? decision.when('escalate', { is: Joi.exist(), otherwise: Joi.required() })
      : decision.required(),
    ...(withEscalate ? { escalate } : {}),
    finding: Joi.string()
      .valid('holds', 'ruled-out')
      .description(
        "Only when the question is about a reviewer's finding: 'holds' when the finding stands and implement fixes it, 'ruled-out' when it does not hold; leave out otherwise",
      ),
    waitFor: planKeys.needs.description('Tasks the asking task waits for; leave out when none'),
    addTask: Joi.array().items(taskSchema()).description('Tasks to add; leave out when none'),
    changeTask: Joi.array()
      .items(
        Joi.object({
          id: Joi.string().required().description('A task that has not started'),
          reason,
          title: Joi.string(),
          description: Joi.string(),
          files: list(),
          proof: Joi.string(),
          depends: list(),
          covers: list(),
        }),
      )
      .description('Changes to tasks that have not started; leave out when none'),
    dropTask: Joi.array()
      .items(Joi.object({ id: Joi.string().required().description('A task that has not started'), reason }))
      .description('Tasks that have not started and are dropped; leave out when none'),
  });
}

/** The answer to a part's question: a decision, or an escalation of what the planner cannot settle. */
export const starterAnswer = defineResult('starter_answer', starterSchema(true));

/** The same answer without `escalate`, for a reader that answers no part's question and has nothing to hand up. */
export const starterAnswerWithoutEscalate = defineResult('starter_answer', starterSchema(false));
