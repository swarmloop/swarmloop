import { access, readdir } from 'fs/promises';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { isOutputFileOf } from '../core/attempt-output';
import type { RunEntity } from '../history/entities';
import { removeTreeAsync, root } from '../history/run-paths';
import { RunRepository } from '../history/run.repository';
import { resolveCheckoutPath } from '../config/checkout-path';
import { CheckoutService } from '../steps/shared/checkout.service';

const DAY_MS = 86_400_000;

/**
 * Takes the worktrees, agent state and output files of runs that finished long ago. The rows, documents, events,
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

  /** Cleans every done run that finished more than `days` ago, oldest first. 0 keeps everything. */
  async apply(days: number, except?: string): Promise<string[]> {
    const cleaned: string[] = [];
    for (const run of await this.candidates(days, except)) {
      if (await this.clean(run)) {
        cleaned.push(run.key);
      }
    }
    return cleaned;
  }

  /** Cleans the oldest done run that is at least a day old. Null when there is none. */
  async cleanOldest(except: string): Promise<string | null> {
    for (const run of await this.candidates(1, except)) {
      if (await this.clean(run)) {
        return run.key;
      }
    }
    return null;
  }

  /** The one gate: only a run that is done (a row from before `state` existed counts by its status), not held and not cleaned yet, and old enough, is ever touched. */
  private async candidates(days: number, except?: string): Promise<RunEntity[]> {
    if (days <= 0) {
      return [];
    }
    const limit = this.clock.now() - days * DAY_MS;
    return (await this.runs.listRuns())
      .filter(
        (run) =>
          (run.state === 'done' || (run.state === null && run.status === 'done')) &&
          run.key !== except &&
          run.workspace !== 'removed' &&
          !this.runs.held(run) &&
          Date.parse(run.updatedAt) <= limit,
      )
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  }

  /** A failure is logged and the run stays as it was marked, so one run does not stop the others. */
  private async clean(run: RunEntity): Promise<boolean> {
    try {
      await this.removeWorkspace(run);
      await this.runs.markWorkspaceRemoved(run.key);
      return true;
    } catch (error) {
      this.logger.warn(`retention of ${run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async removeWorkspace(run: RunEntity): Promise<void> {
    const base = root(this.config);
    const worktrees = join(base, 'worktrees', run.key);
    for (const name of await entries(worktrees)) {
      await this.removeWorktree(name, join(worktrees, name));
    }
    await removeTreeAsync(worktrees);
    await removeTreeAsync(join(base, 'data', 'agent-state', run.key));
    const data = join(base, 'data');
    for (const name of await entries(data)) {
      if (isOutputFileOf(name, run.key)) {
        await removeTreeAsync(join(data, name));
      }
    }
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
