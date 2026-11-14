import Joi from 'joi';

/** One task of a split plan, as the planner writes it. */
export interface SplitTask {
  id: string;
  title: string;
  depends: string[];
  files: string[];
  proof: string;
  description: string;
}

/** One capability of a split plan that must keep working, and the tasks that touch it. */
export interface SplitKeep {
  capability: string;
  proof: string;
  tasks: string[];
}

/** The fields of an answer that splits the run into subtasks. They are empty in an answer that does not split. */
export interface SplitFields {
  contract: string[];
  tasks: SplitTask[];
  keep: SplitKeep[];
}

const list = (): Joi.ArraySchema => Joi.array().items(Joi.string());

/** The schema keys of a split answer, shared by `plan` and `plan_improve`. */
export function splitKeys(): Record<string, Joi.Schema> {
  return {
    contract: list()
      .default([])
      .description('one decision every subtask follows per entry; a multi-line entry keeps its line breaks'),
    tasks: Joi.array()
      .items(
        Joi.object({
          id: Joi.string().required().description('A short slug'),
          title: Joi.string().required(),
          depends: list().default([]).description('Ids of the tasks done first'),
          files: list().required().description('Every file it changes'),
          proof: Joi.string().required().description('The test or check that proves it'),
          description: Joi.string().required().description('What the task does, kept whole'),
        }),
      )
      .default([])
      .description('the tasks, and no plan'),
    keep: Joi.array()
      .items(
        Joi.object({
          capability: Joi.string().required(),
          proof: Joi.string().required().description('Its test, or "new <test>"'),
          tasks: list().required().description('Ids of the tasks it touches'),
        }),
      )
      .default([])
      .description('capabilities that only need their test rerun'),
  };
}

/** The keys of an answer, or only the ones the run can use: the split keys leave out a run that may not split. */
export function keysFor(keys: Record<string, Joi.Schema>, hidden: string[]): Record<string, Joi.Schema> {
  return Object.fromEntries(Object.entries(keys).filter(([name]) => !hidden.includes(name)));
}
