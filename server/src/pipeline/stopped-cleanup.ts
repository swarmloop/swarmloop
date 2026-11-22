import { Logger } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import { REASON } from '../contract/run-state';
import { storedState } from '../history/run-state';
import type { SandboxService } from '../sandbox/sandbox.service';

/** The document a Stop writes when Docker did not answer: its body is the step whose containers are still to go. */
export const STOP_CLEANUP = 'stop_cleanup';

/** Removes the containers of stopped runs that Docker did not answer for at the Stop, once per reconciler tick. */
export class StoppedCleanup {
  private readonly logger = new Logger(StoppedCleanup.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly sandbox: SandboxService,
    private readonly config: AppConfig,
  ) {}

  async run(): Promise<void> {
    const runs = await this.runs.listRuns();
    const marks = await this.documents.latestDocuments(
      runs.map(({ id }) => id),
      [STOP_CLEANUP],
    );
    for (const mark of marks) {
      const step = mark.body.trim();
      const run = runs.find(({ id }) => id === mark.runId);
      if (!step || !run) continue;
      try {
        // Only the Stop that wrote the document is worked off: a run that went on since has a container of its own.
        if (run.status !== 'blocked' || storedState(run).reason?.code !== REASON.stopped) {
          await this.documents.putDocument(run, STOP_CLEANUP, '');
        } else if ((await this.sandbox.stopRun(run.key, step, this.config.env.STOP_GRACE_S)) === 'gone') {
          await this.documents.putDocument(run, STOP_CLEANUP, '');
        }
      } catch (error) {
        this.logger.warn(`cleanup of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
