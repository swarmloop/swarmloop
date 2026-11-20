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
  waitFor?: Need[];
  addTask?: SplitTask[];
  changeTask?: TaskChange[];
  dropTask?: TaskDrop[];
}

const reason = Joi.string().required().description('Why');

export const starterAnswer = defineResult(
  'starter_answer',
  Joi.object({
    decision: Joi.string().required().description('The decision the task follows, written to the contract'),
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
  }),
);
