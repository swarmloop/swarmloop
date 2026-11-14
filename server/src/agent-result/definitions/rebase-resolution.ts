import Joi from 'joi';
import { defineResult } from '../result-definition';

/** What the agent hands back after it resolved a rebase conflict. */
export interface RebaseResolutionResult {
  summary: string[];
}

export const rebaseResolution = defineResult(
  'rebase_resolution',
  Joi.object({
    summary: Joi.array()
      .items(Joi.string())
      .required()
      .description('How each conflict was resolved, one line per entry'),
  }),
);
