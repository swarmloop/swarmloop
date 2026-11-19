import Joi from 'joi';
import { defineResult } from '../result-definition';
import { CHANGE_KEY, GIT_RULES_KEY } from './git-change';

/** The answer to a host's refusal of a name: the change again, and the rule the refusal names. */
export const gitRefusal = defineResult(
  'git_refusal',
  Joi.object({ change: CHANGE_KEY.required(), gitRules: GIT_RULES_KEY }),
);
