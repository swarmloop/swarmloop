import type { Logger } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import type { RunRetention } from './run-retention';
import { skipRun } from './skip-run';

/** What the close of a subtask run needs from its port. */
interface SubtaskEndPort {
  stop(run: RunEntity): Promise<void>;
  closeMergeRequests(parent: RunEntity, run: RunEntity): Promise<void>;
}

/**
 * Ends the run of a subtask its epic skipped or ended: it stops, reads `skipped` with the reason in words, its open
 * merge requests are closed, and its workspace goes through retention's one removal. A failure is logged and the next
 * pass over the ended epic tries again.
 */
export class SubtaskEnd {
  constructor(
    private readonly runs: RunRepository,
    private readonly port: SubtaskEndPort,
    private readonly logger: Logger,
    private readonly retention?: RunRetention,
  ) {}

  async close(parent: RunEntity, child: RunEntity, reason: string): Promise<void> {
    try {
      const skipped = await skipRun(this.runs, (run) => this.port.stop(run), child, reason);
      if (skipped) await this.port.closeMergeRequests(parent, skipped);
      const run = skipped ?? child;
      if (run.workspace !== 'removed') await this.retention?.free(run);
    } catch (error) {
      this.logger.warn(`closing ${child.key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
