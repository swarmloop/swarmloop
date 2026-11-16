import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import type { Requirement } from '../../contract/requirement-list';

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
  /** The requirements of the input, ids R1.. in its order; a subtask is not asked for them. */
  requirements?: Requirement[];
  needs?: Need[];
}

const keys = {
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
};

const requirementsKey = Joi.array().items(
  Joi.object({
    id: Joi.string().required().description('R1, R2 ... in the order of the input'),
    text: Joi.string().required().description('The one thing the input asks for'),
  }),
);

/** Every field of the research result, the requirements optional: the definition its stored kind is read with. */
export const research = defineResult('research', Joi.object({ ...keys, requirements: requirementsKey }));

/**
 * The research result a run is asked for: a run that is not a subtask must list its requirements, a subtask is not told
 * about them (the server builds its list) and an answer that sends them anyway is read without error. The kind is the same.
 */
export function researchFor(subtask: boolean): ResultDefinition {
  const schema = subtask
    ? Joi.object(keys).unknown(true)
    : Joi.object({
        ...keys,
        requirements: requirementsKey
          .min(1)
          .required()
          .description('Every requirement of the input, one entry each, ids R1.. in the input order'),
      });
  return { ...research, schema };
}
