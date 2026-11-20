import Joi from 'joi';
import { CODE_REVIEWERS } from '../../contract/steps';
import { defineResult } from '../result-definition';
import type { ResultDefinition } from '../result-definition';
import { QUESTION } from './starter-fields';

/** The mark of one requirement of the Requirements list. */
export interface RequirementMark {
  id: string;
  status: 'met' | 'partial' | 'missing';
  note: string;
}

/** What one code reviewer hands to the server. */
export interface ReviewResult {
  decision: 'ok' | 'return';
  review: string;
  summary: string[];
  /** Only the requirements review has it: where each required behavior already is in the tree. */
  met?: string[];
  /** Only the requirements review has it: one mark for each id of the Requirements list. */
  requirements?: RequirementMark[];
  /** Only a reviewer that saw implement's answer to its last finding gives it. */
  reason?: string;
  /** One choice the reviewer cannot settle from the brief, the requirements, the plan and the decisions. */
  question?: string;
}

const REQUIREMENT_MARK = Joi.object({
  id: Joi.string().required(),
  status: Joi.string().valid('met', 'partial', 'missing').required(),
  note: Joi.string().required().description('What the diff does for it, or what is missing'),
});

function reviewSchema(name: string): Joi.ObjectSchema {
  const requirements = name === 'requirements';
  const fields: Joi.SchemaMap = {
    decision: Joi.string()
      .valid('ok', 'return')
      .required()
      .description('ok when this angle passes; return when a broken behavior must be fixed first'),
    review: Joi.string()
      .required()
      .description(
        requirements
          ? 'Your review in Markdown, ending with the summary list; on return it names every requirement that is not met'
          : 'Your review in Markdown, ending with the summary list; on return it names one broken behavior',
      ),
    summary: Joi.array()
      .items(Joi.string())
      .required()
      .description(
        requirements
          ? 'The summary list, one line per entry; what you checked'
          : 'The summary list, one line per entry; what you checked, or the marks of the input list',
      ),
    question: QUESTION,
  };
  return Joi.object(
    requirements
      ? {
          ...fields,
          met: Joi.array().items(Joi.string()).description('where each required behavior already is'),
          requirements: Joi.array()
            .items(REQUIREMENT_MARK)
            .description('One entry for each id of the Requirements list, with its mark'),
        }
      : fields,
  );
}

/** `review_<name>` for every reviewer of the code review. */
const REVIEW_DEFINITIONS: ReadonlyMap<string, ResultDefinition> = new Map(
  CODE_REVIEWERS.map((name) => [name, defineResult(`review_${name}`, reviewSchema(name))]),
);

const REASON = Joi.string()
  .required()
  .description('One line: why the answer of implement holds (ok) or why your finding still holds (return)');

/** The result of a reviewer that decides again after implement's answer: the same result with its reason. */
export function reviewAnswerDefinition(name: string): ResultDefinition {
  const base = reviewDefinition(name);
  return { ...base, schema: base.schema.keys({ reason: REASON }) };
}

/** The result as stored: the reason is there only when the reviewer saw an answer. */
export function reviewStoredDefinition(name: string): ResultDefinition {
  const base = reviewDefinition(name);
  return { ...base, schema: base.schema.keys({ reason: Joi.string() }) };
}

export function reviewDefinition(name: string): ResultDefinition {
  const found = REVIEW_DEFINITIONS.get(name);
  if (!found) {
    throw new Error(`${name} is not a code reviewer`);
  }
  return found;
}
