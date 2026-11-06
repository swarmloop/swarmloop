import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import type { StepCapabilities } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { dirname, isAbsolute, join, resolve } from 'path';
import { Injectable } from '@nestjs/common';
import { CheckoutRepository } from '../../history/checkout.repository';
import { root } from '../../history/run-paths';
import { StepName } from '../../contract/steps';
import { assignCodeHost, type CodeHostName } from '../../integrations/code-host/code-host.registry';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail } from '../../git/git';
import { BaseStep, StepContext } from '../base-step';
import { CheckoutService } from '../shared/checkout.service';
import { CHECKOUT_NAME, listGitProjects, resolveCheckoutPath, storedProjects } from './checkout-path';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

/** The requirements record must exist to start. Prepare does not read it, so it is not loaded. */
const INPUTS = {
  requirements: { artifact: ARTIFACTS.requirements, need: 'start', late: true },
} as const satisfies InputSpec;

@Injectable()
export class PrepareStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'prepare';
  readonly inputs = INPUTS;
  /** The repos, added repos and pending repos documents are written for prepare by `ProjectAppendService`. */
  readonly outputs = [ARTIFACTS.repos, ARTIFACTS.addedRepos, ARTIFACTS.pendingRepos];
  override readonly capabilities: StepCapabilities = { revisesRequirements: true };

  constructor(
    kernel: StepKernel,
    private readonly checkouts: CheckoutRepository,
    private readonly worktrees: CheckoutService,
  ) {
    super(kernel);
  }

  protected override failureText(error: unknown): string {
    return error instanceof SwarmloopError ? error.message : gitDetail(error);
  }

  protected async work(_input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { opened } = ctx;
    const { key } = opened.run;
    const selected = storedProjects(opened.run.projects).map((name) => ({ name, path: '' }));
    const checkouts: { name: string; path: string }[] =
      selected.length > 0 ? selected : await this.checkouts.listCheckouts();
    if (checkouts.length === 0) {
      throw new SwarmloopError('projects is missing');
    }
    const hosts: (CodeHostName | null)[] = [];
    for (const checkout of checkouts) {
      const located = await this.worktrees.prepareCheckout(key, checkout, opened.run.prompt);
      hosts.push(await this.worktrees.classified(located));
    }
    assignCodeHost(opened.run, hosts, true);
    return {
      route: { to: 'next' },
      summary: [
        `${opened.startedAt} prepare done`,
        'Run unit tests from the worktree. The shared Docker stack can serve only one worktree at a time.',
      ].join('\n'),
      outputs: [],
      handoff: `- prepared ${checkouts.map((checkout) => checkout.name).join(', ')}\n`,
    };
  }

  async listClones(): Promise<{ name: string }[]> {
    const rows = await this.checkouts.listCheckouts();
    return rows.map((row) => ({ name: row.name }));
  }

  listProjects(): { projects: string[] } {
    return { projects: listGitProjects(root(this.config), this.config.env.CHECKOUTS_ROOT) };
  }

  async addClone(name: string): Promise<{ name: string }> {
    const trimmed = name.trim();
    if (!CHECKOUT_NAME.test(trimmed)) {
      throw new SwarmloopError('checkout name is invalid');
    }
    const path = resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, trimmed, '');
    const located = { name: trimmed, path };
    this.worktrees.assertCheckout(located);
    await this.worktrees.assertGit(located);
    await this.checkouts.saveCheckout(trimmed, '');
    return { name: trimmed };
  }

  async removeWorktrees(key: string): Promise<void> {
    const directory = join(root(this.config), 'worktrees', key);
    if (!existsSync(directory)) {
      return;
    }
    if (linkedWorktree(directory)) {
      await this.unregisterWorktree(directory);
    } else {
      for (const name of readdirSync(directory)) {
        const child = join(directory, name);
        if (linkedWorktree(child)) {
          await this.unregisterWorktree(child);
        }
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }

  private async unregisterWorktree(worktree: string): Promise<void> {
    let main = '';
    try {
      const common = await git(['-C', worktree, 'rev-parse', '--git-common-dir']);
      main = dirname(isAbsolute(common) ? common : resolve(worktree, common));
    } catch {
      rmSync(worktree, { recursive: true, force: true });
      return;
    }
    if (samePlace(main, worktree)) {
      return;
    }
    try {
      await git(['-C', main, 'worktree', 'remove', '--force', worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
      try {
        await git(['-C', main, 'worktree', 'prune']);
      } catch {
        return;
      }
    }
  }
}

function linkedWorktree(path: string): boolean {
  const marker = join(path, '.git');
  return existsSync(marker) && statSync(marker).isFile();
}

function samePlace(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}
