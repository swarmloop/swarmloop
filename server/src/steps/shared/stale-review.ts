import { Injectable } from '@nestjs/common';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { VisitRepository } from '../../history/visit.repository';
import { ARTIFACTS } from '../contract/artifacts';

interface StaleReason {
  /** Why the latest review report does not count: `review was for other files`, or `review was for generation 1, now 2`. */
  reason: string;
  /** True when that report was written after the last time merge-request sent this run back: sending it back again would loop. */
  again: boolean;
}

/** Tells a review report that is missing from one that exists but was written for other files or another generation. */
@Injectable()
export class StaleReview {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly visits: VisitRepository,
  ) {}

  /** Null when the run has no review report. */
  async reason(run: RunEntity): Promise<StaleReason | null> {
    const [report] = await this.documents.latestDocuments([run.id], [ARTIFACTS.reviewReport.kind]);
    if (!report) {
      return null;
    }
    const stamp = await this.documents.latestStamp(run.key, ARTIFACTS.reviewReport.kind);
    const reason =
      stamp?.generation !== undefined && stamp.generation !== run.generation
        ? `review was for generation ${stamp.generation}, now ${run.generation}`
        : 'review was for other files';
    const stats = await this.visits.listStats(run.id);
    // The reviewers' own visits are written before the code-review visit, so they are skipped when looking at what follows.
    const sentBack = stats.filter(
      (stat, index) =>
        stat.step === 'merge-request' &&
        stat.status === 'done' &&
        stats.slice(index + 1).find((later) => !later.step.startsWith('code-review-'))?.step === 'code-review',
    );
    const last = sentBack[sentBack.length - 1];
    return { reason, again: last !== undefined && report.stepStatId > last.id };
  }
}
