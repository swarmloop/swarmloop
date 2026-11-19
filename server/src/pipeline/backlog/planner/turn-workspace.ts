import { rmSync } from 'fs';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/env';
import type { SandboxMount } from '../../../core/sandbox-mount';
import { mountsForStep } from '../../../git/repo-names';
import type { BacklogRecord } from '../../../history/backlog-writers';
import { root } from '../../../history/run-paths';
import { CheckoutService } from '../../../steps/shared/checkout.service';

type Checkout = { name: string; path: string };

/** What a turn mounts: the folder of its worktrees, one read only mount for each repository, and the repository names. */
interface TurnWorkspace {
  workspace: string;
  mounts: SandboxMount[];
  names: string[];
}

/** The worktrees a turn reads: one for each repository of the backlog, at the fetched head of its default branch. */
@Injectable()
export class BacklogTurnWorkspace {
  private readonly worktrees = new Map<string, Checkout[]>();

  constructor(
    private readonly checkouts: CheckoutService,
    private readonly config: AppConfig,
  ) {}

  /** Makes the worktrees under the turn key. A failure part way removes what was made and throws. */
  async open(backlog: Pick<BacklogRecord, 'owner' | 'repositories'>, turnKey: string): Promise<TurnWorkspace> {
    const made: Checkout[] = [];
    this.worktrees.set(turnKey, made);
    try {
      for (const name of backlog.repositories) {
        made.push(await this.checkouts.prepareCheckout(turnKey, { name, path: '' }, null, backlog.owner));
      }
      const mounts = mountsForStep(root(this.config), turnKey, backlog.repositories, null).map((mount) => ({
        ...mount,
        readonly: true,
      }));
      return { workspace: this.folder(turnKey), mounts, names: [...backlog.repositories].sort() };
    } catch (error) {
      await this.close(turnKey).catch(() => undefined);
      throw error;
    }
  }

  /** Removes the turn's worktrees. Safe to call for a turn that never opened or already closed; every worktree is tried before it throws. */
  async close(turnKey: string): Promise<void> {
    const made = this.worktrees.get(turnKey) ?? [];
    this.worktrees.delete(turnKey);
    let failure: Error | undefined;
    for (const checkout of made) {
      try {
        await this.checkouts.removeWorktree(checkout, join(this.folder(turnKey), checkout.name));
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    rmSync(this.folder(turnKey), { recursive: true, force: true });
    if (failure) throw failure;
  }

  private folder(turnKey: string): string {
    return join(root(this.config), 'worktrees', turnKey);
  }
}
