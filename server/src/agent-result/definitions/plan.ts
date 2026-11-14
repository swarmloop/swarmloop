import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import type { Need } from './research';
import { keysFor, splitKeys, type SplitFields } from './split-fields';

/** What the plan step hands to the server: one checklist, the questions a person must answer, or a split into tasks. */
export interface PlanResult extends SplitFields {
  summary: string[];
  plan: string[];
  questions: string[];
  name?: string;
  overview?: string;
  needs?: Need[];
}

const filled = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/** The rule of a plan answer: a checklist, questions or a split, and only one of them. */
export function planShapeError(value: Partial<PlanResult>): string | null {
  return [value.plan, value.questions, value.tasks].filter(filled).length === 1
    ? null
    : 'exactly one of plan, questions and tasks must be filled in';
}

const keys = {
  summary: Joi.array().items(Joi.string()).required().description('Why this checklist, one line per entry'),
  plan: Joi.array()
    .items(Joi.string())
    .default([])
    .description('The checklist, one item per entry, each ending with its files and proof'),
  questions: Joi.array()
    .items(Joi.string())
    .default([])
    .description('Questions for a person, one per entry, instead of a plan'),
  name: Joi.string().description('A name for the plan'),
  overview: Joi.string().description('A short overview of the plan'),
  needs: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().required().description('Sibling task id'),
        what: Joi.string().required().description('What it needs from that task'),
      }),
    )
    .description('Sibling tasks this task waits for; leave out when none'),
  ...splitKeys(),
};

function schemaOf(hidden: string[]): Joi.ObjectSchema {
  // A field a run was not asked for is not described to it. An answer that sends one is told by the step's own check.
  return Joi.object(keysFor(keys, hidden))
    .unknown(hidden.length > 0)
    .custom((value: PlanResult, helpers) => {
      const error = filled(value.needs) ? null : planShapeError(value);
      return error ? helpers.message({ custom: error }) : value;
    });
}

const SPLIT_KEYS = ['contract', 'tasks', 'keep'];

/** Every field of the plan result: the definition its stored kind is read with. */
export const plan = defineResult('plan', schemaOf([]));

/**
 * The plan result a run is asked for: a run that may not split is not told about tasks, a run that is not a subtask is
 * not told about `needs`, and none is told about the name and overview the stored result may hold. The kind is the same.
 */
export function planFor(shape: { split: boolean; subtask: boolean }): ResultDefinition {
  const hidden = ['name', 'overview', ...(shape.split ? [] : SPLIT_KEYS), ...(shape.subtask ? [] : ['needs'])];
  return { ...plan, schema: schemaOf(hidden) };
}

/** An answer read through `planFor`, with the fields it was not asked for as empty as the stored result has them. */
export function completePlan(value: Partial<PlanResult>): PlanResult {
  const known = Object.fromEntries(Object.entries(value).filter(([name]) => Object.hasOwn(keys, name)));
  return { summary: [], plan: [], questions: [], contract: [], tasks: [], keep: [], ...known };
}
