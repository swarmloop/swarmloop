import type { Logger } from '@nestjs/common';
import type { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { settledAt } from '../steps/shared/subtask-settled-at';
import type { ReportRefresh } from '../steps/shared/report-refresh';
import type { SubtaskWorktrees } from './subtask-worktrees';

/** What the parent writes down when it merged the requests of a subtask run: the outcome, the files and its report. */
export class SubtaskMergeRecord {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly clock: Clock,
    private readonly worktrees: SubtaskWorktrees,
    private readonly branchOf: (parent: RunEntity) => Promise<string>,
    private readonly reportRefresh: ReportRefresh | undefined,
    private readonly logger: Logger,
  ) {}

  async recordMerged(parent: RunEntity, run: RunEntity, merged: Record<string, string>): Promise<void> {
    await this.recordMergedFiles(parent, run, merged);
    try {
      const fresh = await this.runs.findById(run.id);
      if (fresh?.status !== 'done' || fresh.mergeOutcome) return;
      const at = this.clock.iso();
      const facts = Object.fromEntries(
        Object.entries(merged).map(([repo, sha]) => [repo, { sha: sha || null, by: null, at, url: null }]),
      );
      await this.runs.release(fresh, { status: 'done', doneAt: fresh.doneAt ?? at, merge: { merged: facts } });
    } catch (error) {
      this.logger.warn(
        `The merge of ${run.key} was not recorded on its run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.refreshReport(parent);
  }

  /** The ISO time a task of the parent was merged or skipped, or null when it is not settled or the time is not known. */
  async settledAt(parent: RunEntity, taskId: string): Promise<string | null> {
    return settledAt(this.runs, this.documents, parent, taskId);
  }

  /** Makes the parent's report current at a task merge. No step scope is open, so a failure is a warning; the next step end tries again. */
  private async refreshReport(parent: RunEntity): Promise<void> {
    try {
      await this.reportRefresh?.refresh(parent);
    } catch (error) {
      this.logger.warn(
        `the report of ${parent.key} was not refreshed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The files the merge of each repository changed, taken from its merge commit. A merge git cannot read leaves none. */
  private async recordMergedFiles(parent: RunEntity, run: RunEntity, merged: Record<string, string>): Promise<void> {
    try {
      const files = await this.worktrees.changedFiles(run, merged, await this.branchOf(parent));
      await this.documents.putDocument(run, ARTIFACTS.mergedFiles.kind, files.join('\n'));
    } catch (error) {
      this.logger.warn(
        `The files of the merge of ${run.key} were not read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
