import { Injectable, type Logger } from '@nestjs/common';
import type { RunEntity } from '../../history/entities';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import type { SubtaskMergeRequest } from './subtask-ops';

/**
 * Closes the open merge requests of a subtask run. A merged request stays as it is, and a close that fails, or a
 * list that cannot be read, is logged: the caller goes on.
 */
export async function closeRequests(
  registry: CodeHostRegistry,
  parent: RunEntity,
  child: RunEntity,
  list: () => Promise<SubtaskMergeRequest[]>,
  logger: Logger,
): Promise<void> {
  try {
    const host = (await registry.forRun(parent.startedBy, parent.codeHost)).byName(parent.codeHost);
    for (const request of await list()) {
      await host.closeMergeRequest(request.project, request.iid);
    }
  } catch (error) {
    logger.warn(
      `merge requests of ${child.key} were not closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Closes the open merge requests of a subtask run, for a layer that may not reach the code hosts itself. */
@Injectable()
export class SubtaskRequestCloser {
  constructor(private readonly registry: CodeHostRegistry) {}

  close(
    parent: RunEntity,
    child: RunEntity,
    list: () => Promise<SubtaskMergeRequest[]>,
    logger: Logger,
  ): Promise<void> {
    return closeRequests(this.registry, parent, child, list, logger);
  }
}
