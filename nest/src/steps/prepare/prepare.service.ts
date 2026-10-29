import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { DocumentDraft, sampleSelf, VisitDraft } from '../../history/visit';
import { closeStep, openStep, OpenedStep } from '../../pipeline/step-run';
import { PipelineResult } from '../../pipeline/pipeline-result';
import { assignCodeHost, codeHostFromOrigin, CodeHostName } from '../../providers/host-credentials';
import { SwarmloopError } from '../../swarmloop-error';
import { originRef, promptBase, PromptBase } from '../base-ref';
import { git, gitDetail } from '../git';
import { recordHandoff } from '../model-step';
import { CHECKOUT_NAME, listGitProjects, resolveCheckoutPath, storedProjects } from './checkout-path';

@Injectable()
export class PrepareService {
  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
  ) {}

  async execute(key: string): Promise<PipelineResult> {
    const opened = await openStep(this.history, key, 'prepare');
    const end = (outcome: 'ok' | 'failed' | 'waiting', status: string, exitCode: number, line: string, documents?: DocumentDraft[]) =>
      closeStep({
        history: this.history,
        run: opened.run,
        previousStep: opened.previousStep,
        previousStatus: opened.previousStatus,
        step: 'prepare',
        outcome,
        visit: { ...prepareVisit(opened, status, exitCode), ...(documents ? { documents } : {}) },
        line,
        exitCode,
      });
    try {
      const selected = storedProjects(opened.run.projects).map((name) => ({ name, path: '' }));
      const checkouts: { name: string; path: string }[] = selected.length > 0 ? selected : await this.history.listCheckouts();
      if (checkouts.length === 0) {
        throw new SwarmloopError('projects is missing');
      }
      const env = readEnv(this.config);
      const hosts: (CodeHostName | null)[] = [];
      for (const checkout of checkouts) {
        const located = await this.prepareCheckout(key, checkout, opened.run.prompt);
        hosts.push(await this.classified(located, env.GITLAB_BASE_URL, env.GITHUB_BASE_URL));
      }
      assignCodeHost(opened.run, hosts, true);
      const handoff = await recordHandoff(
        this.history,
        key,
        'prepare',
        `- prepared ${checkouts.map((checkout) => checkout.name).join(', ')}\n`,
      );
      return end(
        'ok',
        'done',
        0,
        [
          `${opened.startedAt} prepare done`,
          'Run unit tests from the worktree. The shared Docker stack can serve only one worktree at a time.',
        ].join('\n'),
        [handoff],
      );
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : gitDetail(error);
      return end('failed', 'failed', 1, `${opened.startedAt} ${message}`);
    }
  }

  async listClones(): Promise<{ name: string }[]> {
    const rows = await this.history.listCheckouts();
    return rows.map((row) => ({ name: row.name }));
  }

  listProjects(): { projects: string[] } {
    return { projects: listGitProjects(this.history.root(), readEnv(this.config).CHECKOUTS_ROOT) };
  }

  async addClone(name: string): Promise<{ name: string }> {
    const trimmed = name.trim();
    if (!CHECKOUT_NAME.test(trimmed)) {
      throw new SwarmloopError('checkout name is invalid');
    }
    const path = resolveCheckoutPath(this.history.root(), readEnv(this.config).CHECKOUTS_ROOT, trimmed, '');
    const located = { name: trimmed, path };
    this.assertCheckout(located);
    await this.assertGit(located);
    await this.history.saveCheckout(trimmed, '');
    return { name: trimmed };
  }

  async removeWorktrees(key: string): Promise<void> {
    const directory = join(this.history.root(), 'worktrees', key);
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

  async ensureDetached(run: { key: string; codeHost: string }, names: string[], prompt: string | null, replace: boolean): Promise<void> {
    const env = readEnv(this.config);
    const hosts: (CodeHostName | null)[] = [];
    for (const name of names) {
      const located = await this.prepareCheckout(run.key, { name, path: '' }, prompt);
      hosts.push(await this.classified(located, env.GITLAB_BASE_URL, env.GITHUB_BASE_URL));
    }
    assignCodeHost(run, hosts, replace);
  }

  private async prepareCheckout(key: string, checkout: { name: string; path: string }, prompt: string | null): Promise<{ name: string; path: string }> {
    if (!CHECKOUT_NAME.test(checkout.name)) {
      throw new SwarmloopError('checkout name is invalid');
    }
    const located = {
      name: checkout.name,
      path: resolveCheckoutPath(this.history.root(), readEnv(this.config).CHECKOUTS_ROOT, checkout.name, checkout.path),
    };
    this.assertCheckout(located);
    await this.assertGit(located);
    const ref = await this.checkoutRef(located, prompt);
    const worktree = join(this.history.root(), 'worktrees', key, located.name);
    if (!existsSync(worktree)) {
      mkdirSync(join(this.history.root(), 'worktrees', key), { recursive: true });
      await this.addWorktree(located, worktree, ref);
      return located;
    }
    if (!(await this.registered(located, worktree))) {
      if (!leftoverOnly(worktree)) {
        throw new SwarmloopError(`${located.name} worktree path is not empty`);
      }
      rmSync(worktree, { recursive: true, force: true });
      await this.addWorktree(located, worktree, ref);
      return located;
    }
    if (ref !== 'HEAD') {
      await this.align(located, worktree, ref);
    }
    return located;
  }

  private async classified(checkout: { name: string; path: string }, gitlabBase: string, githubBase: string): Promise<CodeHostName | null> {
    const origin = await this.originOf(checkout);
    return origin ? codeHostFromOrigin(origin, gitlabBase, githubBase) : null;
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

  private async checkoutRef(checkout: { name: string; path: string }, prompt: string | null): Promise<string> {
    const wanted = promptBase(prompt);
    const remotes = await git(['-C', checkout.path, 'remote']);
    if (!remotes.split('\n').includes('origin')) {
      if (wanted.kind === 'named') {
        throw new SwarmloopError(`${checkout.name} has no ${originRef(wanted.name)}`);
      }
      return 'HEAD';
    }
    try {
      await git(['-C', checkout.path, 'fetch', 'origin']);
    } catch {
      // A ref already stored locally still works when the remote is unreachable.
    }
    return this.storedRef(checkout, wanted);
  }

  private async storedRef(checkout: { name: string; path: string }, wanted: PromptBase): Promise<string> {
    if (wanted.kind === 'named') {
      const named = await this.optionalRef(checkout, originRef(wanted.name));
      if (named) {
        return named;
      }
    }
    const main = await this.optionalRef(checkout, 'origin/main');
    if (main) {
      return main;
    }
    return this.verifyRef(checkout, 'origin/master');
  }

  private async optionalRef(checkout: { name: string; path: string }, ref: string): Promise<string | null> {
    try {
      return await this.verifyRef(checkout, ref);
    } catch (error) {
      if (error instanceof SwarmloopError) {
        return null;
      }
      throw error;
    }
  }

  private async verifyRef(checkout: { name: string; path: string }, ref: string): Promise<string> {
    try {
      await git(['-C', checkout.path, 'rev-parse', '--verify', ref]);
      return ref;
    } catch (error) {
      throw new SwarmloopError(`${checkout.name} has no ${ref}: ${gitDetail(error)}`);
    }
  }

  private async assertGit(checkout: { name: string; path: string }): Promise<void> {
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

  private async addWorktree(checkout: { name: string; path: string }, worktree: string, ref: string): Promise<void> {
    try {
      await git(['-C', checkout.path, 'worktree', 'add', '--detach', worktree, ref]);
    } catch (error) {
      throw new SwarmloopError(`${checkout.name} worktree failed: ${gitDetail(error)}`);
    }
  }

  private async registered(checkout: { name: string; path: string }, worktree: string): Promise<boolean> {
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

  private assertCheckout(checkout: { name: string; path: string }): void {
    if (!isAbsolute(checkout.path) || !existsSync(checkout.path) || !statSync(checkout.path).isDirectory()) {
      throw new SwarmloopError(`${checkout.name} is not a git checkout`);
    }
  }

}

function prepareVisit(opened: OpenedStep, status: string, exitCode: number): VisitDraft {
  return {
    step: 'prepare',
    model: null,
    mode: null,
    startedAt: opened.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - opened.started,
    status,
    exitCode,
    killReason: null,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    samples: [sampleSelf()],
    exchange: null,
    httpCalls: [],
    document: null,
    resumed: false,
  };
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

function leftoverOnly(worktree: string): boolean {
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

