import Joi from 'joi';

/** One choice the step cannot settle itself. The server takes it to the planner of the run and the step waits for the answer. */
export const QUESTION = Joi.string().description(
  'One choice you cannot settle from the brief, the requirements, the plan and the decisions; leave out when none',
);

/** A decision a task made that another task may depend on: an item of the contract it owns, and what it settled. */
export interface StarterDecision {
  item: string;
  text: string;
}

/** A part of the work that no step of the task and no other task will do. */
export interface OutOfScope {
  what: string;
  /** Whether the task needs that part done before it can go on. */
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
          what: Joi.string()
            .required()
            .description('The part of the work that no step of this task and no other task will do'),
          needed: Joi.boolean().required().description('true when this task cannot go on without that part'),
        }),
      )
      .description(
        "Parts of the work that no step of this task and no other task will do: the work of this task's own later steps (plan, implement, review) is never out of scope, and a step that cannot write never lists the writing; leave out when none",
      ),
  };
}
