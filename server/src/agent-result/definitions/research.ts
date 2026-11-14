import Joi from 'joi';
import { defineResult } from '../result-definition';

/** A sibling task that a task needs before it can go on, and what it needs from it. */
export interface Need {
  id: string;
  what: string;
}

interface ImpactItem {
  capability: string;
  file: string;
  status: string;
}

/** What the research step hands to the server. */
export interface ResearchResult {
  summary: string[];
  questions: string[];
  impact: ImpactItem[];
  needs?: Need[];
}

export const research = defineResult(
  'research',
  Joi.object({
    summary: Joi.array().items(Joi.string()).required().description('What the tree shows, one line per entry'),
    questions: Joi.array()
      .items(Joi.string())
      .required()
      .description('Open questions for a person, one per entry; [] when none'),
    impact: Joi.array()
      .items(
        Joi.object({
          capability: Joi.string().required().description('The capability'),
          file: Joi.string().required().description('Its file'),
          status: Joi.string()
            .pattern(/^(kept|changed|removed|unreachable)\b/)
            .required()
            .description('kept, changed, removed or unreachable; a removal may add a note'),
        }),
      )
      .required()
      .description('Capabilities the task touches; [] when none'),
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
