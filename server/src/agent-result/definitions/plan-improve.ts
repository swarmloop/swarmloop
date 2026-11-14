import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import { keysFor, splitKeys, type SplitFields } from './split-fields';

/** What plan-improve hands to the server: the checked checklist or the checked split. An empty plan keeps the stored one. */
export interface PlanImproveResult extends SplitFields {
  summary: string[];
  plan: string[];
}

const keys = {
  summary: Joi.array().items(Joi.string()).required().description('Why, one line per entry'),
  plan: Joi.array()
    .items(Joi.string())
    .default([])
    .description('The full corrected checklist, one per entry; [] keeps the plan, or when you split'),
  ...splitKeys(),
};

function schemaOf(hidden: string[]): Joi.ObjectSchema {
  return Joi.object(keysFor(keys, hidden))
    .unknown(hidden.length > 0)
    .custom((value: Partial<PlanImproveResult>, helpers) =>
      value.plan?.length && value.tasks?.length
        ? helpers.message({ custom: 'plan and tasks cannot both be filled in' })
        : value,
    );
}

/** Every field of the plan-improve result: the definition its stored kind is read with. */
export const planImprove = defineResult('plan_improve', schemaOf([]));

/** The plan-improve result a run is asked for: a run that may not split is not told about tasks. */
export function planImproveFor(split: boolean): ResultDefinition {
  return { ...planImprove, schema: schemaOf(split ? [] : ['contract', 'tasks', 'keep']) };
}

/** An answer read through `planImproveFor`, with the fields it was not asked for as empty as the stored result has them. */
export function completePlanImprove(value: Partial<PlanImproveResult>): PlanImproveResult {
  const known = Object.fromEntries(Object.entries(value).filter(([name]) => name in keys));
  return { summary: [], plan: [], contract: [], tasks: [], keep: [], ...known };
}
