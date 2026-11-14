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
}

export const implementation = defineResult(
  'implementation',
  Joi.object({
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
  }),
);
