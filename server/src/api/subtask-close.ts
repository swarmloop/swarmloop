import { Injectable, Logger } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { SubtaskPort } from '../pipeline/subtask-port';
import { closeRequests } from '../steps/shared/subtask-requests-close';

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
      await closeRequests(this.hosts, parent, child, () => this.subtasks.mergeRequests(child), this.logger);
    }
  }
}
