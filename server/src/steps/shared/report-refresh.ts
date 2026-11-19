import { Injectable, Logger } from '@nestjs/common';
import { runActivity } from '../../core/step-event-scope';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { RunNames } from './run-names';
import { ARTIFACTS } from '../contract/artifacts';
import {
  parseMergeRequests,
  parseMergeRequestSummaries,
  renderMergeRequest,
} from '../merge-request/merge-request-record';
import { reportOf, spliceReport } from './report-markers';
import { RunReport } from './run-report';

/**
 * Keeps the report in the merge requests of a run current. It renders the report again, and when the text changed it
 * replaces the marked part of each request's body. It never throws: a failure is a failed activity and a warning,
 * and the next call tries again.
 */
@Injectable()
export class ReportRefresh {
  private readonly logger = new Logger(ReportRefresh.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly runReport: RunReport,
    private readonly registry: CodeHostRegistry,
    private readonly names: RunNames,
  ) {}

  async refresh(opened: RunEntity): Promise<void> {
    try {
      const run = (await this.runs.findRun(opened.key)) ?? opened;
      const stored = await this.documents.latestBody(run.key, ARTIFACTS.mergeRequest.kind);
      const report = stored ? (await this.runReport.render(run))?.trim() : null;
      if (!stored || !report || parseMergeRequestSummaries(stored).every((summary) => reportOf(summary) === report)) {
        return;
      }
      await runActivity('Update the merge request report', () => this.update(run, stored, report));
    } catch (error) {
      this.logger.warn(
        `the merge request report of ${opened.key} was not updated: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async update(run: RunEntity, stored: string, report: string): Promise<void> {
    const requirements = await this.documents.latestBody(run.key, ARTIFACTS.requirements.kind);
    if (!requirements?.trim()) {
      return;
    }
    const branch = await this.names.branch(run, null);
    const host = await this.registry.hostFor(run);
    const summaries = parseMergeRequestSummaries(stored);
    const records = [];
    for (const [index, record] of parseMergeRequests(stored).entries()) {
      const { record: current } = await host.findMergeRequest({ project: record.project, source: branch });
      const body = current ? spliceReport(current.summary, report) : null;
      if (current && body !== null && body !== current.summary) {
        await host.updateMergeRequest(record.project, record.iid, body);
      }
      records.push({ ...record, summary: body ?? summaries[index] ?? '' });
    }
    await this.documents.putDocument(run, ARTIFACTS.mergeRequest.kind, renderMergeRequest(records));
  }
}
