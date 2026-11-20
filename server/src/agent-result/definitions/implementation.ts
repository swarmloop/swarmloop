import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import { CHANGE_KEY, GIT_RULES_KEY, type GitChange, type GitRules } from './git-change';
import type { Need } from './research';
import { QUESTION, starterKeys, type OutOfScope, type StarterDecision } from './starter-fields';

/** What the implement step hands to the server. */
export interface ImplementationResult {
  implementation: string[];
  summary: string[];
  cause?: string[];
  plan?: string[];
  needs?: Need[];
  rejected?: RejectedFinding[];
  question?: string;
  change?: GitChange;
  gitRules?: GitRules;
  decisions?: StarterDecision[];
  outOfScope?: OutOfScope[];
}

/** A code review finding the step leaves unfixed, and why it does not hold. */
export interface RejectedFinding {
  reviewer: string;
  finding: string;
  reason: string;
}

const keys = {
  implementation: Joi.array()
    .items(Joi.string())
    .required()
    .description('What you changed, one entry per change; [] only when a sibling task must go first (needs)'),
  summary: Joi.array().items(Joi.string()).required().description('Why this way, one line per entry'),
  cause: Joi.array()
    .items(Joi.string())
    .description('Root cause, one line per entry; only for a return naming a failure'),
  plan: Joi.array()
    .items(Joi.string())
    .description('The full corrected checklist, one per entry; leave out when no item changes'),
  needs: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().required().description('Sibling task id'),
        what: Joi.string().required().description('What it needs'),
      }),
    )
    .description('Sibling tasks this task waits for; leave out when none'),
  question: QUESTION,
  change: CHANGE_KEY,
  gitRules: GIT_RULES_KEY,
};

const base = Joi.object(keys);

export const implementation = defineResult('implementation', base);

/** The findings a step leaves unfixed after a code review return, one entry each. Used only on that pass. */
export const REJECTED = Joi.array()
  .items(
    Joi.object({
      reviewer: Joi.string().required().description('The reviewer name of the finding, as the return names it'),
      finding: Joi.string().required().description('The finding'),
      reason: Joi.string().required().description('Why the finding does not hold'),
    }),
  )
  .description(
    'Each code review finding you do not fix: the reviewer, the finding, and why it does not hold; leave out when you fix every finding',
  );

/** Every field of an implement answer: the definition its stored kind is read with. */
export const implementationAfterReview = defineResult(
  'implementation',
  Joi.object({ ...keys, rejected: REJECTED, ...starterKeys() }),
);

/**
 * The implement answer a run is asked for: the pass that answers a code review return also reports the findings it
 * leaves unfixed, and only a subtask is told about `decisions` and `outOfScope`. The kind is the same.
 */
export function implementationFor(shape: { subtask: boolean; review: boolean }): ResultDefinition {
  const asked = {
    ...keys,
    ...(shape.review ? { rejected: REJECTED } : {}),
    ...(shape.subtask ? starterKeys() : {}),
  };
  return { ...implementationAfterReview, schema: Joi.object(asked) };
}
