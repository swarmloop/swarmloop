import { legacyReviewReport, reviewReport, storedReviewReport } from './definitions/review-report';
import type { LegacyReviewReportResult, ReviewReportResult } from './definitions/review-report';
import { resultArtifactCodec } from './result-codec';

const current = resultArtifactCodec<ReviewReportResult>(reviewReport);
const stored = resultArtifactCodec<ReviewReportResult>(storedReviewReport);
const legacy = resultArtifactCodec<LegacyReviewReportResult>(legacyReviewReport);

/**
 * The stored report result of any shape: the current one, then the one of a run reviewed by the retired reviewers (its
 * notes are theirs), then the one of runs from before the report was rendered by the server.
 */
export const reviewReportCodec = {
  parse: (body: string): ReviewReportResult | LegacyReviewReportResult => {
    try {
      return current.parse(body);
    } catch (error) {
      for (const read of [stored, legacy]) {
        try {
          return read.parse(body);
        } catch {
          // The next shape is tried; the error of the current shape is the one that is thrown.
        }
      }
      throw error;
    }
  },
  format: (value: ReviewReportResult | LegacyReviewReportResult): string => current.format(value as ReviewReportResult),
};
