import Joi from 'joi';
import { CODE_REVIEWERS } from '../../contract/steps';
import { defineResult } from '../result-definition';

/** The place a person should read and why. */
export interface WorthALook {
  place: string;
  reason: string;
}

/** What the report step hands to the server: the prose of the report. The server writes the rest. */
export interface ReviewReportResult {
  line: string;
  done: string[];
  worthALook: WorthALook[];
  notes: Record<(typeof CODE_REVIEWERS)[number], string>;
  risk: 'low' | 'medium' | 'high';
  riskReason: string;
}

/** The parts of a report stored before the report was rendered by the server. Read only. */
export interface LegacyReviewReportResult {
  requirements?: string;
  whatChanged: string;
  codeReview: string;
  whatHolds?: string;
  whatToFix?: string;
}

const MAX_DONE = 5;
const MAX_WORTH_A_LOOK = 3;

const WORTH_A_LOOK = Joi.object({
  place: Joi.string().required().description('A file or an area of the change'),
  reason: Joi.string().required().description('Why a person should read it there, in one line'),
});

const NOTES = Joi.object(
  Object.fromEntries(
    CODE_REVIEWERS.map((name) => [
      name,
      Joi.string()
        .required()
        .description(`One line on what the ${name} review found. Do not give its decision: the server adds it`),
    ]),
  ),
);

export const reviewReport = defineResult(
  'review_report',
  Joi.object({
    line: Joi.string().required().description('What the change gives, in one plain line'),
    done: Joi.array()
      .items(Joi.string())
      .min(1)
      .max(MAX_DONE)
      .required()
      .description(
        `At most ${MAX_DONE} bullets of one line each: what was built. For a split parent, the whole change`,
      ),
    worthALook: Joi.array()
      .items(WORTH_A_LOOK)
      .max(MAX_WORTH_A_LOOK)
      .required()
      .description(`At most ${MAX_WORTH_A_LOOK} places to read with the reason; empty when nothing needs a look`),
    notes: NOTES.required(),
    risk: Joi.string().valid('low', 'medium', 'high').required().description('How risky the change is to merge'),
    riskReason: Joi.string().required().description('The reason for the risk, in one line'),
  }),
);

/** The old shape, validated for reading only. */
export const legacyReviewReport = defineResult(
  'review_report',
  Joi.object({
    requirements: Joi.string(),
    whatChanged: Joi.string().required(),
    codeReview: Joi.string().required(),
    whatHolds: Joi.string(),
    whatToFix: Joi.string(),
  }),
);

/** True for a stored result of the old shape: it has no `done`. */
export function isLegacyReport(
  result: ReviewReportResult | LegacyReviewReportResult,
): result is LegacyReviewReportResult {
  return !('done' in result);
}
