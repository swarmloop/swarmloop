import Joi from 'joi';
import { CODE_REVIEWERS, STORED_REVIEWERS } from '../../contract/steps';
import type { StoredReviewer } from '../../contract/steps';
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
  /** One note per reviewer of the round. A run reviewed by the retired reviewers has theirs, and none for the three. */
  notes: Partial<Record<StoredReviewer, string>>;
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

/** The notes of a stored report: any reviewer a run can have, none required, so a report of the retired five reads. */
const STORED_NOTES = Joi.object(Object.fromEntries(STORED_REVIEWERS.map((name) => [name, Joi.string()])));

function reportParts(notes: Joi.ObjectSchema): Joi.SchemaMap {
  return {
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
    notes: notes.required(),
    risk: Joi.string().valid('low', 'medium', 'high').required().description('How risky the change is to merge'),
    riskReason: Joi.string().required().description('The reason for the risk, in one line'),
  };
}

export const reviewReport = defineResult('review_report', Joi.object(reportParts(NOTES)));

/** The report as stored, validated for reading only: the same parts, with the notes of any stored reviewer. */
export const storedReviewReport = defineResult('review_report', Joi.object(reportParts(STORED_NOTES)));

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
