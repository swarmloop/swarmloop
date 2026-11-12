import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { git } from '../git/git';
import { root } from '../history/run-paths';
import { listGitProjects, resolveCheckoutPath } from '../config/checkout-path';
import { CheckoutService } from '../steps/shared/checkout.service';
import { DiskGuard } from './disk-guard';
import { RunRetention } from './run-retention';

const DAY_MS = 86_400_000;
const CATCH_UP_MARKER = 'retention-catch-up';

/** What the API process does on its own: at startup, and once a day. A CLI process never runs it. */
@Injectable()
export class Housekeeping implements OnModuleDestroy {
  private readonly logger = new Logger(Housekeeping.name);
  private timer: NodeJS.Timeout | null = null;
  private freeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly checkouts: CheckoutService,
    private readonly retention: RunRetention,
    private readonly disk: DiskGuard,
    private readonly clock: Clock,
  ) {}

  /**
   * Prunes the registrations whose worktree is gone in this container, locks the live ones, and, the first time,
   * applies retention to the runs that finished before it existed.
   */
  async startup(): Promise<void> {
    try {
      await this.tidyRegistrations();
    } catch (error) {
      this.logger.warn(`worktree registrations were not tidied: ${String(error)}`);
    }
    const marker = join(root(this.config), 'data', CATCH_UP_MARKER);
    if (existsSync(marker)) {
      return;
    }
    await this.retention.apply(this.config.env.RETAIN_DONE_DAYS);
    mkdirSync(join(root(this.config), 'data'), { recursive: true });
    writeFileSync(marker, `${this.clock.iso()}\n`);
  }

  /** Once a day: dangling images and old build cache. Every `MERGE_WATCH_MIN` minutes: the workspaces of merged and closed runs. */
  schedule(): void {
    this.stop();
    this.timer = setInterval(() => void this.disk.pruneDocker(), DAY_MS);
    this.timer.unref();
    this.freeTimer = setInterval(() => void this.freeSettledRuns(), this.config.env.MERGE_WATCH_MIN * 60_000);
    this.freeTimer.unref();
  }

  private async freeSettledRuns(): Promise<void> {
    try {
      await this.retention.apply(this.config.env.RETAIN_DONE_DAYS);
    } catch (error) {
      this.logger.warn(`retention pass failed: ${String(error)}`);
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.freeTimer) clearInterval(this.freeTimer);
    this.freeTimer = null;
  }

  private async tidyRegistrations(): Promise<void> {
    const base = root(this.config);
    const own = join(base, 'worktrees');
    for (const name of listGitProjects(base, this.config.env.CHECKOUTS_ROOT, this.config.env.SWARMLOOP_REPOS)) {
      const checkout = { name, path: resolveCheckoutPath(base, this.config.env.CHECKOUTS_ROOT, name, '') };
      const listed = await git(['-C', checkout.path, 'worktree', 'list', '--porcelain']);
      for (const block of listed.split('\n\n')) {
        const lines = block.split('\n');
        const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
        if (!path?.startsWith(`${own}/`)) {
          continue;
        }
        const locked = lines.find((line) => line === 'locked' || line.startsWith('locked '));
        if (!existsSync(path)) {
          if (locked?.includes('swarmloop run')) {
            await git(['-C', checkout.path, 'worktree', 'unlock', path]);
          }
        } else if (!locked) {
          await this.checkouts.lockWorktree(path.slice(own.length + 1).split('/')[0], checkout, path);
        }
      }
      await git(['-C', checkout.path, 'worktree', 'prune']);
    }
  }
}
