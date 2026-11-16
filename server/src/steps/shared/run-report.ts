import { Injectable } from '@nestjs/common';
import { isLegacyReport } from '../../agent-result/definitions/review-report';
import type { ReviewReportResult } from '../../agent-result/definitions/review-report';
import { Clock } from '../../core/clock';
import { CheckCommandRepository } from '../../history/check-command.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { ARTIFACTS } from '../contract/artifacts';
import { readReportFacts, type ReportFactsDeps, type RoundReview } from './report-facts';
import { renderRunReport } from './report-text';
import { readStored } from './report-stored';

/** The report of a run, rendered in one place for the code review that stores it and the merge request that shows it. */
@Injectable()
export class RunReport {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly visits: VisitRepository,
    private readonly flows: FlowRepository,
    private readonly checkCommands: CheckCommandRepository,
    private readonly runs: RunRepository,
    private readonly clock: Clock,
  ) {}

  private deps(): ReportFactsDeps {
    return {
      documents: this.documents,
      visits: this.visits,
      flows: this.flows,
      checkCommands: this.checkCommands,
      runs: this.runs,
      clock: this.clock,
    };
  }

  /** The report text for the model's parts. `round` holds the reviews of a round whose documents are not stored yet. */
  async renderParts(run: RunEntity, parts: ReviewReportResult, round: RoundReview[] = []): Promise<string> {
    return renderRunReport(await readReportFacts(this.deps(), run, round), parts);
  }

  /** The report text from the run's latest stored parts. Null when it has none, or they are of the old shape. */
  async render(run: RunEntity): Promise<string | null> {
    const body = await this.documents.latestBody(run.key, ARTIFACTS.reviewReportResult.kind);
    const parts = body ? readStored(() => ARTIFACTS.reviewReportResult.parse(body)) : null;
    return parts && !isLegacyReport(parts) ? this.renderParts(run, parts) : null;
  }
}
