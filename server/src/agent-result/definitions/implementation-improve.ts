import Joi from 'joi';
import { defineResult } from '../result-definition';
import { CHANGE_KEY, GIT_RULES_KEY, type GitChange, type GitRules } from './git-change';
import { QUESTION, REJECTED, type RejectedFinding } from './implementation';

/** What the implement-improve step hands to the server. An empty `implementation` keeps the first pass. */
export interface ImplementationImproveResult {
  implementation?: string[];
  summary: string[];
  cause?: string[];
  plan?: string[];
  rejected?: RejectedFinding[];
  question?: string;
  change?: GitChange;
  gitRules?: GitRules;
}

const base = Joi.object({
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
  change: CHANGE_KEY,
  gitRules: GIT_RULES_KEY,
});

export const implementationImprove = defineResult('implementation_improve', base);

/** The result of an improve pass that answers a code review return. */
export const implementationImproveAfterReview = defineResult(
  'implementation_improve',
  base.keys({ rejected: REJECTED }),
);
