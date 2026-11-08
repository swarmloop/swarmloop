import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import { Injectable } from '@nestjs/common';
import { root } from '../../history/run-paths';
import { assignCodeHost, CodeHostRegistry, type CodeHostName } from '../../integrations/code-host/code-host.registry';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail } from '../../git/git';
import { storedBase } from '../../git/rebase';
import { git as quietGit } from '../../git/worktree-tree';
import { CHECKOUT_NAME, resolveCheckoutPath } from '../prepare/checkout-path';
import { StepKernel } from '../step-kernel';

/** Puts the run's worktrees in place: one detached worktree per project, at the stored base. */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly kernel: StepKernel,
    private readonly registry: CodeHostRegistry,
  ) {}

  async ensureDetached(
    run: { key: string; codeHost: string },
    names: string[],
    prompt: string | null,
    replace: boolean,
  ): Promise<void> {
    const hosts: (CodeHostName | null)[] = [];
    for (const name of names) {
      const located = await this.prepareCheckout(run.key, { name, path: '' }, prompt);
      hosts.push(await this.classified(located));
    }
    assignCodeHost(run, hosts, replace);
  }

  async prepareCheckout(
    key: string,
    checkout: { name: string; path: string },
    prompt: string | null,
  ): Promise<{ name: string; path: string }> {
    if (!CHECKOUT_NAME.test(checkout.name)) {
      throw new SwarmloopError('checkout name is invalid');
    }
    const env = this.kernel.config.env;
    const located = {
      name: checkout.name,
      path: resolveCheckoutPath(root(this.kernel.config), env.CHECKOUTS_ROOT, checkout.name, checkout.path),
    };
    this.assertCheckout(located);
    await this.assertGit(located);
    const ref = await storedBase(located.path, located.name, prompt, { ...env, clock: this.kernel.clock }, 'prepare');
    const worktree = join(root(this.kernel.config), 'worktrees', key, located.name);
    if (!existsSync(worktree)) {
      mkdirSync(join(root(this.kernel.config), 'worktrees', key), { recursive: true });
      await this.addWorktree(key, located, worktree, ref);
      return located;
    }
    if (!(await this.registered(located, worktree))) {
      if (!leftoverOnly(worktree)) {
        throw new SwarmloopError(`${located.name} worktree path is not empty`);
      }
      rmSync(worktree, { recursive: true, force: true });
      await this.addWorktree(key, located, worktree, ref);
      return located;
    }
    if (ref !== 'HEAD') {
      await this.align(located, worktree, ref);
    }
    return located;
  }

  async classified(checkout: { name: string; path: string }): Promise<CodeHostName | null> {
    const origin = await this.originOf(checkout);
    return origin ? this.registry.forOrigin(origin) : null;
  }

  private async originOf(checkout: { name: string; path: string }): Promise<string | null> {
    try {
      const url = (await git(['-C', checkout.path, 'remote', 'get-url', 'origin'])).trim();
      return url || null;
    } catch (error) {
      if (gitDetail(error).includes('No such remote')) {
        return null;
      }
      throw new SwarmloopError(`${checkout.name} origin failed: ${gitDetail(error)}`);
    }
  }

  async assertGit(checkout: { name: string; path: string }): Promise<void> {
    try {
      const inside = await git(['-C', checkout.path, 'rev-parse', '--is-inside-work-tree']);
      if (inside !== 'true') {
        throw new SwarmloopError(`${checkout.name} is not a git checkout`);
      }
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw error;
      }
      throw new SwarmloopError(`${checkout.name} is not a git checkout`);
    }
  }

  /**
   * The one place that adds a worktree. The registration is locked right away, so a `git worktree prune` that a
   * person runs in their own checkout (where the container paths do not exist) leaves it alone. Without `branch` the
   * worktree is detached at `ref`; with it the worktree is on that branch, created from `ref` when `create` is set.
   */
  async addWorktree(
    key: string,
    checkout: { name: string; path: string },
    worktree: string,
    ref: string,
    branch?: { name: string; create: boolean },
  ): Promise<void> {
    const args = !branch
      ? ['--detach', worktree, ref]
      : branch.create
        ? ['-b', branch.name, worktree, ref]
        : [worktree, branch.name];
    try {
      await git(['-C', checkout.path, 'worktree', 'add', ...args]);
      await this.lockWorktree(key, checkout, worktree);
    } catch (error) {
      throw new SwarmloopError(`${checkout.name} worktree failed: ${gitDetail(error)}`);
    }
  }

  /**
   * Marks the registration as swarmloop's, so a prune or gc from a person's own checkout leaves it alone. It is
   * bookkeeping, not a step of the run, so it does not show as a command in the trace of the step.
   */
  async lockWorktree(key: string, checkout: { name: string; path: string }, worktree: string): Promise<void> {
    await quietGit(checkout.path, ['worktree', 'lock', '--reason', `swarmloop run ${key}`, worktree]);
  }

  /** Drops the registration of a worktree whose directory is gone, so the path can be added again. */
  async forgetWorktree(checkout: { name: string; path: string }, worktree: string): Promise<void> {
    try {
      await git(['-C', checkout.path, 'worktree', 'unlock', worktree]);
    } catch (error) {
      if (!gitDetail(error).includes('not locked')) {
        throw new SwarmloopError(`${checkout.name} worktree failed: ${gitDetail(error)}`);
      }
    }
    await git(['-C', checkout.path, 'worktree', 'prune']);
  }

  /** The one place that removes a worktree: unlock first, then remove. Ignored files such as node_modules go with it. */
  async removeWorktree(checkout: { name: string; path: string }, worktree: string): Promise<void> {
    try {
      await git(['-C', checkout.path, 'worktree', 'unlock', worktree]);
    } catch (error) {
      if (!gitDetail(error).includes('not locked')) {
        throw new SwarmloopError(`${checkout.name} worktree failed: ${gitDetail(error)}`);
      }
    }
    try {
      await git(['-C', checkout.path, 'worktree', 'remove', '--force', worktree]);
    } catch (error) {
      throw new SwarmloopError(`${checkout.name} worktree failed: ${gitDetail(error)}`);
    }
  }

  async registered(checkout: { name: string; path: string }, worktree: string): Promise<boolean> {
    try {
      const listed = await git(['-C', checkout.path, 'worktree', 'list', '--porcelain']);
      return listsWorktree(listed, worktree);
    } catch (error) {
      throw new SwarmloopError(`${checkout.name} is not a git checkout: ${gitDetail(error)}`);
    }
  }

  private async align(checkout: { name: string; path: string }, worktree: string, ref: string): Promise<void> {
    const head = await git(['-C', worktree, 'rev-parse', 'HEAD']);
    const target = await git(['-C', checkout.path, 'rev-parse', ref]);
    if (head === target) {
      return;
    }
    const dirty = await git(['-C', worktree, 'status', '--porcelain']);
    if (dirty) {
      throw new SwarmloopError(`${checkout.name} worktree is dirty`);
    }
    try {
      await git(['-C', worktree, 'checkout', '--detach', ref]);
    } catch (error) {
      throw new SwarmloopError(`${checkout.name} worktree is not ${ref}: ${gitDetail(error)}`);
    }
  }

  assertCheckout(checkout: { name: string; path: string }): void {
    if (!isAbsolute(checkout.path) || !existsSync(checkout.path) || !statSync(checkout.path).isDirectory()) {
      throw new SwarmloopError(`${checkout.name} is not a git checkout`);
    }
  }
}

export function leftoverOnly(worktree: string): boolean {
  return readdirSync(worktree).every((entry) => entry === '.git');
}

function listsWorktree(porcelain: string, worktree: string): boolean {
  const real = realpathSync(worktree);
  return porcelain.split('\n').some((line) => {
    if (!line.startsWith('worktree ')) {
      return false;
    }
    const listed = line.slice('worktree '.length);
    return existsSync(listed) && realpathSync(listed) === real;
  });
}
