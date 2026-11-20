import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import type { Need } from './research';
import { CHANGE_KEY, type GitChange } from './git-change';
import { starterKeys, type OutOfScope, type StarterDecision } from './starter-fields';
import { coversKey, keysFor, splitKeys, storedContractKey, type SplitFields } from './split-fields';

/** What the plan step hands to the server: one checklist, the questions a person must answer, or a split into tasks. */
export interface PlanResult extends SplitFields {
  summary: string[];
  plan: string[];
  /** One list of requirement ids per plan item, in the order of the plan. */
  covers?: string[][];
  /** What the change means, for its commit and merge request title; a stored plan may have none. */
  change?: GitChange;
  questions: string[];
  name?: string;
  overview?: string;
  needs?: Need[];
  question?: string;
  decisions?: StarterDecision[];
  outOfScope?: OutOfScope[];
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
  covers: coversKey(),
  change: CHANGE_KEY,
  ...starterKeys(),
  ...splitKeys(),
};

function schemaOf(hidden: string[], stored = false): Joi.ObjectSchema {
  // A field a run was not asked for is not described to it. An answer that sends one is told by the step's own check.
  const used = stored ? { ...keys, contract: storedContractKey() } : keys;
  return Joi.object(keysFor(used, hidden))
    .unknown(hidden.length > 0)
    .custom((value: PlanResult, helpers) => {
      if (hidden.includes('questions') && filled(value.questions)) {
        return helpers.message({ custom: 'questions: send `question` instead' });
      }
      const error = filled(value.needs) || value.question?.trim() ? null : planShapeError(value);
      return error ? helpers.message({ custom: error }) : value;
    });
}

/** The schema keys of a plan answer, which the planner's reply builds on. */
export { keys as planKeys };

const SPLIT_KEYS = ['contract', 'tasks', 'keep'];

/** Every field of the plan result: the definition its stored kind is read with. */
export const plan = defineResult('plan', schemaOf([], true));

/** The fields only a subtask is told about: what it hands back to the run that started it. */
export const STARTER_FIELDS = Object.keys(starterKeys());

/**
 * The plan result a run is asked for: a run that may not split is not told about tasks, a run that is not a subtask is
 * not told about `needs`, `question`, `decisions` and `outOfScope`, a subtask asks `question` in place of `questions`,
 * and none is told about the name and overview the stored result may hold. The kind is the same.
 */
export function planFor(shape: { split: boolean; subtask: boolean }): ResultDefinition {
  const hidden = [
    'name',
    'overview',
    ...(shape.split ? [] : SPLIT_KEYS),
    ...(shape.subtask ? ['questions'] : ['needs', ...STARTER_FIELDS]),
  ];
  return { ...plan, schema: schemaOf(hidden) };
}

/** An answer read through `planFor`, with the fields it was not asked for as empty as the stored result has them. */
export function completePlan(value: Partial<PlanResult>): PlanResult {
  const known = Object.fromEntries(Object.entries(value).filter(([name]) => Object.hasOwn(keys, name)));
  return { summary: [], plan: [], covers: [], questions: [], contract: [], tasks: [], keep: [], ...known };
}
