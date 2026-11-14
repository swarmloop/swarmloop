import Joi from 'joi';
import { CODE_REVIEWERS } from '../../contract/steps';
import { defineResult } from '../result-definition';
import type { ResultDefinition } from '../result-definition';

/** What one code reviewer hands to the server. */
export interface ReviewResult {
  decision: 'ok' | 'return';
  review: string;
  summary: string[];
  /** Only the requirements review has it: where each required behavior already is in the tree. */
  met?: string[];
}

function reviewSchema(name: string): Joi.ObjectSchema {
  const fields: Joi.SchemaMap = {
    decision: Joi.string()
      .valid('ok', 'return')
      .required()
      .description('ok when this angle passes; return when a broken behavior must be fixed first'),
    review: Joi.string()
      .required()
      .description('Your review in Markdown, ending with the summary list; on return it names one broken behavior'),
    summary: Joi.array()
      .items(Joi.string())
      .required()
      .description('The summary list, one line per entry; what you checked, or the marks of the input list'),
  };
  return Joi.object(
    name === 'requirements'
      ? { ...fields, met: Joi.array().items(Joi.string()).description('where each required behavior already is') }
      : fields,
  );
}

/** `review_<name>` for every reviewer of the code review. */
const REVIEW_DEFINITIONS: ReadonlyMap<string, ResultDefinition> = new Map(
  CODE_REVIEWERS.map((name) => [name, defineResult(`review_${name}`, reviewSchema(name))]),
);

export function reviewDefinition(name: string): ResultDefinition {
  const found = REVIEW_DEFINITIONS.get(name);
  if (!found) {
    throw new Error(`${name} is not a code reviewer`);
  }
  return found;
}
