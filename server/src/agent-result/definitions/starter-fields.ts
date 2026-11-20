import Joi from 'joi';
import { QUESTION } from './implementation';

/** A decision a task made that another task may depend on: an item of the contract it owns, and what it settled. */
export interface StarterDecision {
  item: string;
  text: string;
}

/** A part the task must not do and that no task owns. */
export interface OutOfScope {
  what: string;
  /** Whether the task itself needs that part done before it can go on. */
  needed: boolean;
}

/** The fields a run that was started by another run hands back, beside its own result: a question, decisions, a part it leaves out. */
export function starterKeys(): Record<string, Joi.Schema> {
  return {
    question: QUESTION,
    decisions: Joi.array()
      .items(
        Joi.object({
          item: Joi.string().required().description('The id of the contract item the task owns'),
          text: Joi.string().required().description('What it decided, kept whole'),
        }),
      )
      .description('What you decided that another task may depend on; leave out when none'),
    outOfScope: Joi.array()
      .items(
        Joi.object({
          what: Joi.string().required().description('The part you must not do and no task owns'),
          needed: Joi.boolean().required().description('true when your task cannot go on without it'),
        }),
      )
      .description('Parts of the work that belong to no task; leave out when none'),
  };
}
