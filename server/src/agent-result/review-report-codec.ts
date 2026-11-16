import { legacyReviewReport, reviewReport } from './definitions/review-report';
import type { LegacyReviewReportResult, ReviewReportResult } from './definitions/review-report';
import { resultArtifactCodec } from './result-codec';

const current = resultArtifactCodec<ReviewReportResult>(reviewReport);
const legacy = resultArtifactCodec<LegacyReviewReportResult>(legacyReviewReport);

/** The stored report result of either shape: the new one first, then the one of runs from before it. */
export const reviewReportCodec = {
  parse: (body: string): ReviewReportResult | LegacyReviewReportResult => {
    try {
      return current.parse(body);
    } catch (error) {
      try {
        return legacy.parse(body);
      } catch {
        throw error;
      }
    }
  },
  format: (value: ReviewReportResult | LegacyReviewReportResult): string => current.format(value as ReviewReportResult),
};
