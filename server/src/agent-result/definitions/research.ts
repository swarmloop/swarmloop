import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import type { Requirement } from '../../contract/requirement-list';
import { starterKeys, type OutOfScope, type StarterDecision } from './starter-fields';

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
  /** Open questions for a person; a subtask sends `question` instead, so its stored result has none. */
  questions: string[];
  impact: ImpactItem[];
  /** The requirements of the input, ids R1.. in its order; a subtask is not asked for them. */
  requirements?: Requirement[];
  needs?: Need[];
  question?: string;
  decisions?: StarterDecision[];
  outOfScope?: OutOfScope[];
  /** A short title for the run. */
  title?: string;
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
  title: Joi.string().description('A short title for the run: plain words, at most 70 characters, no markdown'),
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
export const research = defineResult(
  'research',
  Joi.object({
    ...keys,
    questions: Joi.array().items(Joi.string()).default([]),
    ...starterKeys(),
    requirements: requirementsKey,
  }),
);

/**
 * The research result a run is asked for: a run that is not a subtask must list its requirements, a subtask is not told
 * about them (the server builds its list), so the prompt does not describe the field, and it asks `question` in place of
 * `questions` (an empty `questions` is read, a filled one is an error) and may report `decisions` and `outOfScope`; an answer that sends them anyway is
 * read without error, and every other unknown key is an error. Whatever it accepts the stored kind reads. The kind is the same.
 */
export function researchFor(subtask: boolean): ResultDefinition {
  const { questions: _questions, ...subtaskKeys } = keys;
  const schema = subtask
    ? Joi.object({ ...subtaskKeys, ...starterKeys() })
        .pattern('requirements', requirementsKey)
        .pattern('questions', Joi.array().length(0))
    : Joi.object({
        ...keys,
        requirements: requirementsKey
          .min(1)
          .required()
          .description('Every requirement of the input, one entry each, ids R1.. in the input order'),
      });
  return { ...research, schema };
}
