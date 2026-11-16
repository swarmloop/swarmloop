import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import type { Requirement } from '../../contract/requirement-list';
import { coversKey, keysFor, splitKeys, type SplitFields } from './split-fields';

/** What plan-improve hands to the server: the checked checklist or the checked split. An empty plan keeps the stored one. */
export interface PlanImproveResult extends SplitFields {
  summary: string[];
  plan: string[];
  /** One list of requirement ids per plan item, in the order of the plan. */
  covers?: string[][];
  /** The requirements added or corrected, with the reason in the summary. */
  requirements?: Requirement[];
}

const keys = {
  summary: Joi.array().items(Joi.string()).required().description('Why, one line per entry'),
  plan: Joi.array()
    .items(Joi.string())
    .default([])
    .description('The full corrected checklist, one per entry; [] keeps the plan, or when you split'),
  covers: coversKey(),
  requirements: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().required().description('The id of the requirement'),
        text: Joi.string().required().description('The requirement'),
      }),
    )
    .default([])
    .description('Only the requirements you add or whose text you correct; [] when the list is right'),
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
  const known = Object.fromEntries(Object.entries(value).filter(([name]) => Object.hasOwn(keys, name)));
  return { summary: [], plan: [], covers: [], requirements: [], contract: [], tasks: [], keep: [], ...known };
}
