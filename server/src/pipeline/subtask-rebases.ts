import type { Logger } from '@nestjs/common';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { ERROR_CODES } from '../contract/error-codes';
import { isSubtask, parseSubtasks, settled, SUBTASKS_KIND } from '../contract/subtask';
import type { RebaseEvent, SubtaskMergeRequest } from '../steps/shared/subtask-ops';
import type { DocumentRepository } from '../history/document.repository';
import { mergeHandoff } from '../steps/shared/handoff';
import type { RunRebase } from '../steps/run-rebase';
import type { CommandService } from './command.service';

/**
 * The rebase commands of the subtask runs of a parent. One rule decides which open parts move for every path that
 * moves an epic's branch: a part that waits on a question or a sibling moves and keeps its wait, a stopped part is
 * left as it is, and any other part moves as its state allows.
 */
export class SubtaskRebases {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly rebaser: RunRebase | undefined,
    private readonly asking: (run: RunEntity) => Promise<boolean>,
    private readonly mergeRequests: (run: RunEntity) => Promise<SubtaskMergeRequest[]>,
    private readonly logger: Logger,
  ) {}

  /** True when the run waits on a question or a sibling: a move puts it on the new tree and leaves it waiting. */
  async keepsWait(run: RunEntity): Promise<boolean> {
    const { state, reason } = storedState(run);
    return state === 'waiting' && (reason?.code === ERROR_CODES.SUBTASK_WAITING || (await this.asking(run)));
  }

  /** True when the run goes on after the move; false when it was not moved or was moved and keeps its wait. */
  async rebase(run: RunEntity, event?: RebaseEvent): Promise<boolean> {
    const take = await this.canTakeRebase(run, !!event);
    if (!take) return false;
    if (storedState(run).state === 'running') {
      if (event) await this.queueRebase(run, event.note);
      return !!event;
    }
    try {
      await this.sendRebase(run, take.keepsWait, event);
    } catch (error) {
      this.logger.warn(`${run.key} was not rebased: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (event) await this.noteRebase(run, event.note);
    return !take.keepsWait;
  }

  /**
   * Sends the Rebase. The key names the event; when the command of that key died, the next try is a new event named
   * after the command that died, so a rebase that failed once is sent again and never the same one twice.
   */
  private async sendRebase(run: RunEntity, keepsWait: boolean, event?: RebaseEvent): Promise<void> {
    const payload = keepsWait ? { byParent: true, keepsWait: true } : { byParent: true };
    if (!event) {
      await this.commands.accept('rebase', run.key, payload, {
        idempotencyKey: `subtask-rebase-${run.revision}-${run.generation}`,
      });
      return;
    }
    let idempotencyKey = `subtask-rebase-${run.key}-${event.tip}`;
    for (;;) {
      const sent = await this.commands.accept('rebase', run.key, payload, { idempotencyKey });
      if (!sent.replayed || sent.command.state !== 'failed') return;
      idempotencyKey = `${idempotencyKey}-after-${sent.command.id}`;
    }
  }

  /**
   * How the run takes a rebase, or null when it does not: a stopped run is a person's, and a blocked or working one
   * is moved only for an event. A run that keeps its wait moves when it has worktrees, a merge request or not.
   */
  private async canTakeRebase(run: RunEntity, byEvent: boolean): Promise<{ keepsWait: boolean } | null> {
    const states = byEvent
      ? ['failed', 'done', 'waiting', 'idle', 'blocked', 'running']
      : ['failed', 'done', 'waiting', 'idle'];
    if (!states.includes(storedState(run).state)) return null;
    // A subtask moved by an event or kept in its wait has worktrees to move even before it made a merge request.
    const worktrees = !!(await this.documents.latestBody(run.key, ARTIFACTS.repos.kind));
    if (await this.keepsWait(run)) return worktrees ? { keepsWait: true } : null;
    if ((await this.mergeRequests(run)).length > 0 || (byEvent && worktrees)) return { keepsWait: false };
    return null;
  }

  private async queueRebase(run: RunEntity, note: string): Promise<void> {
    if ((await this.documents.latestBody(run.key, ARTIFACTS.pendingRebase.kind)) !== note) {
      await this.documents.putDocument(run, ARTIFACTS.pendingRebase.kind, note);
    }
  }

  private async noteRebase(run: RunEntity, note: string): Promise<void> {
    const handoff = await this.documents.latestBody(run.key, ARTIFACTS.handoff.kind);
    await this.documents.putDocument(run, ARTIFACTS.handoff.kind, mergeHandoff(handoff, 'rebase', note));
  }

  /**
   * Takes the rebase a working subtask run was sent, now that its step has ended. Returns the step the run goes on
   * at, or null when nothing was waiting or the rebase was refused.
   */
  async applyPendingRebase(key: string): Promise<string | null> {
    const run = await this.runs.findRun(key);
    const note =
      run && isSubtask(run) ? (await this.documents.latestBody(key, ARTIFACTS.pendingRebase.kind))?.trim() : '';
    if (!run || !note) return null;
    await this.documents.putDocument(run, ARTIFACTS.pendingRebase.kind, '');
    try {
      await this.rebaser?.rebase(key, false, true);
    } catch (error) {
      this.logger.warn(`${key} was not rebased: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const moved = await this.runs.findRun(key);
    if (moved) await this.noteRebase(moved, note);
    return moved?.currentStep ?? null;
  }

  /** Sends a Rebase to every subtask of the parent that is not merged or skipped; with an event, each is moved for that event. */
  async rebaseOpen(parent: RunEntity, event?: RebaseEvent): Promise<void> {
    const open = parseSubtasks(await this.documents.latestBody(parent.key, SUBTASKS_KIND)).filter(
      (task) => !settled(task),
    );
    for (const task of open) {
      const child = await this.runs.findSubtask(parent, task.id);
      if (child) await this.rebase(child, event);
    }
  }
}
