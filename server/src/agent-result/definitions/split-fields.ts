import Joi from 'joi';
import { CHANGE_KEY, type GitChange } from './git-change';

/** One task of a split plan, as the planner writes it. */
export interface SplitTask {
  id: string;
  title: string;
  depends: string[];
  files: string[];
  proof: string;
  description: string;
  /** The ids of the requirements the task serves. */
  covers?: string[];
  /** What the task's own change means. */
  change?: GitChange;
}

/** One decision of the contract: an interface, a name or a format, and the task that makes it. */
export interface ContractItem {
  id: string;
  text: string;
  /** The id of the task that makes the item. Empty in an item read from a contract written as text. */
  owner: string;
}

/** One capability of a split plan that must keep working, and the tasks that touch it. */
export interface SplitKeep {
  capability: string;
  proof: string;
  tasks: string[];
}

/** The fields of an answer that splits the run into subtasks. They are empty in an answer that does not split. */
export interface SplitFields {
  contract: ContractItem[];
  tasks: SplitTask[];
  keep: SplitKeep[];
}

export const list = (): Joi.ArraySchema => Joi.array().items(Joi.string());

/** The `covers` key of a plan answer: the requirement ids each plan item serves. */
export function coversKey(): Joi.ArraySchema {
  return Joi.array()
    .items(list())
    .default([])
    .description('One list of requirement ids per plan item, same order; [] when the plan has no list');
}

/** The schema of one task of a split plan. */
export function taskSchema(): Joi.ObjectSchema {
  return Joi.object({
    id: Joi.string().required().description('A short slug'),
    title: Joi.string().required(),
    depends: list().default([]).description('Ids of the tasks done first'),
    files: list().required().description('Every file it changes'),
    proof: Joi.string().required().description('The test or check that proves it'),
    description: Joi.string().required().description('What the task does, kept whole'),
    covers: list().default([]).description('Ids of the requirements the task serves'),
    change: CHANGE_KEY,
  });
}

function itemSchema(): Joi.ObjectSchema {
  return Joi.object({
    id: Joi.string().required().description('A short slug'),
    text: Joi.string().required().description('The decision, kept whole'),
    owner: Joi.string().required().description('The id of the task that makes it'),
  });
}

/** The contract key of a stored result: it also reads the text entries of a run planned before, as items with no owner. */
export function storedContractKey(): Joi.ArraySchema {
  const text = Joi.string().custom((entry: string): ContractItem => ({ id: '', text: entry, owner: '' }));
  return Joi.array().items(Joi.alternatives().try(itemSchema(), text)).default([]);
}

/** The schema keys of a split answer, shared by `plan` and `plan_improve`. */
export function splitKeys(): Record<string, Joi.Schema> {
  return {
    contract: Joi.array()
      .items(itemSchema())
      .default([])
      .description('one decision every subtask follows per item; the text keeps its line breaks'),
    tasks: Joi.array().items(taskSchema()).default([]).description('the tasks, and no plan'),
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
