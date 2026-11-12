import { access, readdir } from 'fs/promises';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { isOutputFileOf } from '../core/attempt-output';
import { isCheckOutputOf } from '../core/check-output';
import type { RunEntity } from '../history/entities';
import { removeTreeAsync, root } from '../history/run-paths';
import { RunRepository } from '../history/run.repository';
import { resolveCheckoutPath } from '../config/checkout-path';
import { CheckoutService } from '../steps/shared/checkout.service';

const DAY_MS = 86_400_000;

/**
 * Takes the worktrees and agent state of a run that is merged or closed at once, and its output files once it
 * finished long ago. The same goes for a done run that is not merged, after its age. The rows, documents, events,
 * branches, refs and the stored chat ids stay, so a run can always be picked up again.
 */
@Injectable()
export class RunRetention {
  private readonly logger = new Logger(RunRetention.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly checkouts: CheckoutService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /**
   * Frees every merged or closed run at once, cleans every done run that finished more than `days` ago, and removes the
   * output files of freed runs that finished more than `days` ago. 0 keeps the done runs and all output files.
   * Lists the runs where something was removed.
   */
  async apply(days: number, except?: string): Promise<string[]> {
    const cleaned: string[] = [];
    for (const run of await this.candidates(days, except)) {
      if (await this.clean(run, days > 0 && finishedAt(run) <= this.limit(days))) {
        cleaned.push(run.key);
      }
    }
    return cleaned;
  }

  /** Cleans the oldest done run that is at least a day old. Null when there is none. A run with only files left frees no disk. */
  async cleanOldest(except: string): Promise<string | null> {
    for (const run of await this.candidates(1, except)) {
      if (run.workspace !== 'removed' && (await this.clean(run, finishedAt(run) <= this.limit(1)))) {
        return run.key;
      }
    }
    return null;
  }

  private limit(days: number): number {
    return this.clock.now() - days * DAY_MS;
  }

  /**
   * The one gate, never a held run or `except`: a merged or closed run whose workspace is not removed (at any age), a
   * done run (a row from before `state` existed counts by its status) that is not removed and old enough, and a
   * merged or closed run already freed whose output files are old enough.
   */
  private async candidates(days: number, except?: string): Promise<RunEntity[]> {
    const limit = this.limit(days);
    return (await this.runs.listRuns())
      .filter((run) => {
        if (run.key === except || this.runs.held(run)) {
          return false;
        }
        const settled = run.state === 'merged' || run.state === 'closed';
        const old = days > 0 && finishedAt(run) <= limit;
        if (settled) {
          return run.workspace !== 'removed' || old;
        }
        return (
          run.workspace !== 'removed' && old && (run.state === 'done' || (run.state === null && run.status === 'done'))
        );
      })
      .sort((a, b) => finishedAt(a) - finishedAt(b));
  }

  /**
   * A failure is logged and the run stays as it was marked, so one run does not stop the others. The workspace goes
   * when it is still there; the output files go with it when `aged`.
   */
  private async clean(run: RunEntity, aged: boolean): Promise<boolean> {
    try {
      const freed = run.workspace === 'removed';
      if (!freed) {
        await this.removeWorkspace(run);
      }
      const files = aged && (await this.removeHistoryFiles(run));
      if (!freed) {
        await this.runs.markWorkspaceRemoved(run.key);
      }
      return !freed || files;
    } catch (error) {
      this.logger.warn(`retention of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** The one removal of a workspace: the worktrees and the agent state of a run. */
  private async removeWorkspace(run: RunEntity): Promise<void> {
    const base = root(this.config);
    const worktrees = join(base, 'worktrees', run.key);
    for (const name of await entries(worktrees)) {
      await this.removeWorktree(name, join(worktrees, name));
    }
    await removeTreeAsync(worktrees);
    await removeTreeAsync(join(base, 'data', 'agent-state', run.key));
  }

  /** The output files and check outputs of a run. True when any was removed. */
  private async removeHistoryFiles(run: RunEntity): Promise<boolean> {
    const data = join(root(this.config), 'data');
    let removed = false;
    for (const name of await entries(data)) {
      if (isOutputFileOf(name, run.key) || isCheckOutputOf(name, run.key)) {
        await removeTreeAsync(join(data, name));
        removed = true;
      }
    }
    return removed;
  }

  private async removeWorktree(name: string, worktree: string): Promise<void> {
    const checkout = {
      name,
      path: resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, name, ''),
    };
    if (
      !name.startsWith('.') &&
      (await exists(checkout.path)) &&
      (await this.checkouts.registered(checkout, worktree))
    ) {
      await this.checkouts.removeWorktree(checkout, worktree);
    } else {
      await removeTreeAsync(worktree);
    }
  }
}

/** When a run finished. The merge watch's own writes move `updatedAt`, so a done run it has seen keeps its `doneAt`. */
function finishedAt(run: RunEntity): number {
  return Date.parse(run.doneAt ?? run.updatedAt);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The names in a directory, none when it does not exist. */
async function entries(path: string): Promise<string[]> {
  return readdir(path).catch(() => []);
}
