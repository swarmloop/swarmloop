import { Injectable, Logger } from '@nestjs/common';
import { SKIPPED_NOTE } from '../../contract/run-state';
import { BacklogRepository } from '../../history/backlog.repository';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { CommandService } from '../command.service';
import { skipRun } from '../skip-run';

/** A run in one of these states has ended and is left as it is. */
const ENDED = ['done', 'merged', 'skipped', 'closed'];

/** Ends the run of a skipped backlog task as skipped, through the one path a skipped part takes. */
@Injectable()
export class TaskRunSkip {
  private readonly logger = new Logger(TaskRunSkip.name);

  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly chat: PlanChatStore,
    private readonly commands: CommandService,
  ) {}

  /** Skips the run with this key. A missing run and one that has ended are left as they are. */
  async end(runKey: string): Promise<void> {
    const run = await this.runs.findRun(runKey);
    if (!run || ENDED.includes(storedState(run).state)) return;
    await skipRun(
      { runs: this.runs, documents: this.documents, chat: this.chat },
      async (stopped) => {
        await this.commands.submit('stop', stopped.key, {});
      },
      run,
      SKIPPED_NOTE,
    );
  }

  /** Ends the run of every task saved skipped whose run has not ended. A failure is logged and the pass goes on. */
  async endSkipped(): Promise<void> {
    for (const backlog of await this.backlogs.listBacklogs()) {
      for (const task of await this.backlogs.tasks(backlog.id as number)) {
        if (task.status !== 'skipped' || task.runKey === null) continue;
        try {
          await this.end(task.runKey);
        } catch (error) {
          this.logger.warn(
            `ending ${task.runKey} of a skipped task failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}
