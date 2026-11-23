import { access, readdir } from 'fs/promises';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { resolveCheckoutPath } from '../config/checkout-path';
import { removeTreeAsync, root } from '../history/run-paths';
import { RunRepository } from '../history/run.repository';
import { isStateName } from '../sandbox/sandbox-launch';
import { runTmpDir } from '../sandbox/run-tmp';
import { CheckoutService } from '../steps/shared/checkout.service';

/** The one place that frees what a run leaves outside `data/`: its worktrees, its agent state and its /tmp folders. */
@Injectable()
export class RunFolders {
  private readonly logger = new Logger(RunFolders.name);

  constructor(
    private readonly runs: RunRepository,
    private readonly checkouts: CheckoutService,
    private readonly config: AppConfig,
  ) {}

  /** Removes the folders of one run. A worktree of a checkout is unregistered from it, so the checkout keeps its branch. */
  async remove(key: string): Promise<void> {
    const base = root(this.config);
    const worktrees = join(base, 'worktrees', key);
    for (const name of await entries(worktrees)) {
      await this.removeWorktree(name, join(worktrees, name));
    }
    await removeTreeAsync(worktrees);
    await removeTreeAsync(join(base, 'data', 'agent-state', key));
    await removeTreeAsync(runTmpDir(base, key));
  }

  /**
   * Removes the /tmp folder of a run that no longer exists. The folders are listed before the runs are read, so the
   * folder of a run that starts meanwhile is never taken. A failure is logged and the next folder goes on.
   */
  async removeLeftTmp(): Promise<void> {
    const base = root(this.config);
    const names = await entries(join(base, 'worktrees', '.tmp'));
    const keys = new Set((await this.runs.listRuns()).map((run) => run.key));
    for (const name of names) {
      if (!isStateName(name) || keys.has(name)) {
        continue;
      }
      try {
        await removeTreeAsync(runTmpDir(base, name));
      } catch (error) {
        this.logger.warn(`removing /tmp of ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Without a checkouts root no checkout can list the worktree, so the folder is removed as it is. */
  private async removeWorktree(name: string, worktree: string): Promise<void> {
    const location = this.config.env.CHECKOUTS_ROOT
      ? resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, name, '')
      : null;
    const checkout = location && { name, path: location };
    if (
      checkout &&
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
