import Joi from 'joi';
import { defineResult } from '../result-definition';
import type { Need } from './research';

/** What the implement step hands to the server. */
export interface ImplementationResult {
  implementation: string[];
  summary: string[];
  cause?: string[];
  plan?: string[];
  needs?: Need[];
  rejected?: RejectedFinding[];
}

/** A code review finding the step leaves unfixed, and why it does not hold. */
export interface RejectedFinding {
  reviewer: string;
  finding: string;
  reason: string;
}

const base = Joi.object({
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
});

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

/** The result of an implement pass that answers a code review return. */
export const implementationAfterReview = defineResult('implementation', base.keys({ rejected: REJECTED }));
