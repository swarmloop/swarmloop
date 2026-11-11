import { Injectable, Logger } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { SubtaskPort } from '../pipeline/subtask-port';

/** Closes the open merge requests of the subtasks of a parent. */
@Injectable()
export class SubtaskClose {
  private readonly logger = new Logger(SubtaskClose.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly subtasks: SubtaskPort,
    private readonly hosts: CodeHostRegistry,
  ) {}

  /** Closes the open merge requests of the subtasks, then removes their runs and worktrees. */
  async removeAll(parent: RunEntity): Promise<void> {
    await this.closeAll(parent);
    await this.subtasks.removeAll(parent);
  }

  /** A close that fails is logged: the replay or removal goes on. A merged request stays as it is. */
  private async closeAll(parent: RunEntity): Promise<void> {
    for (const child of await this.runs.children(parent)) {
      try {
        const host = (await this.hosts.forRun(parent.startedBy, parent.codeHost)).byName(parent.codeHost);
        for (const request of await this.subtasks.mergeRequests(child)) {
          await host.closeMergeRequest(request.project, request.iid);
        }
      } catch (error) {
        this.logger.warn(
          `merge requests of ${child.key} were not closed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
