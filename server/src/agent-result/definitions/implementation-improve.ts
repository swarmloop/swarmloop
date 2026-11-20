import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import { REJECTED, type RejectedFinding } from './implementation';
import { QUESTION, starterKeys, type OutOfScope, type StarterDecision } from './starter-fields';

/** What the implement-improve step hands to the server. An empty `implementation` keeps the first pass. */
export interface ImplementationImproveResult {
  implementation?: string[];
  summary: string[];
  cause?: string[];
  plan?: string[];
  rejected?: RejectedFinding[];
  question?: string;
  decisions?: StarterDecision[];
  outOfScope?: OutOfScope[];
}

const keys = {
  implementation: Joi.array()
    .items(Joi.string())
    .description('What this pass changed, one entry per change; leave out or [] when nothing changed'),
  summary: Joi.array().items(Joi.string()).required().description('Why, one line per entry'),
  cause: Joi.array()
    .items(Joi.string())
    .description('The root cause, one line per entry; for a return that names a failure, leave out otherwise'),
  plan: Joi.array()
    .items(Joi.string())
    .description('The full corrected checklist, one per entry; leave out when no item changes'),
  question: QUESTION,
};

const base = Joi.object(keys);

export const implementationImprove = defineResult('implementation_improve', base);

/** Every field of an improve answer: the definition its stored kind is read with. */
export const implementationImproveAfterReview = defineResult(
  'implementation_improve',
  Joi.object({ ...keys, rejected: REJECTED, ...starterKeys() }),
);

/**
 * The improve answer a run is asked for: the pass that answers a code review return also reports the findings it
 * leaves unfixed, and only a subtask is told about `decisions` and `outOfScope`. The kind is the same.
 */
export function implementationImproveFor(shape: { subtask: boolean; review: boolean }): ResultDefinition {
  const asked = {
    ...keys,
    ...(shape.review ? { rejected: REJECTED } : {}),
    ...(shape.subtask ? starterKeys() : {}),
  };
  return { ...implementationImproveAfterReview, schema: Joi.object(asked) };
}
