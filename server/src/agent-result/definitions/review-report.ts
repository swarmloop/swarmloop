import Joi from 'joi';
import { defineResult } from '../result-definition';

/** What the report step hands to the server: the parts of the merge request summary. */
export interface ReviewReportResult {
  requirements?: string;
  whatChanged: string;
  codeReview: string;
  whatHolds?: string;
  whatToFix?: string;
}

export const reviewReport = defineResult(
  'review_report',
  Joi.object({
    requirements: Joi.string().description("The requirements reviewer's numbered list with its marks, as it wrote it"),
    whatChanged: Joi.string().required().description('What was done, from the implementation notes, in Markdown'),
    codeReview: Joi.string()
      .required()
      .description('The status of the checks in Markdown; when every decision is ok, what holds'),
    whatHolds: Joi.string().description(
      'The behavior a check that is ok accepted and a later fix must not undo; leave out when every decision is return',
    ),
    whatToFix: Joi.string().description(
      'One bullet per distinct change that must be fixed; leave out when every decision is ok',
    ),
  }),
);
