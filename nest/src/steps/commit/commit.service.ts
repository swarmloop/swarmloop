import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { RunEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { sampleSelf, VisitDraft } from '../../history/visit';
import { PipelineResult, visitStatus } from '../../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../../pipeline/step-run';
import { SwarmloopError } from '../../swarmloop-error';
import { branchName, commitMessage, summaryForBranch } from '../branch/branch-name';
import { authorArgs, git, gitDetail, gitMissing, gitRaw, originUrl, redact } from '../../git/git';
import { recordHandoff, textDocument } from '../model-step';
import { repoNames, worktreePath } from '../repo-names';
import { remoteProject } from '../merge-request/merge-request-record';
import { allowedPaths, deniedIndexPaths, parsePaths, PlannedPath, renderPaths, stageSelection } from './commit-paths';

interface Tree {
  repo: string;
  path: string;
}

export const CI_SKIPPED = 'CI skipped: there is no origin to push.';

@Injectable()
export class CommitService {
  constructor(
    private readonly history: HistoryService,
    private readonly registry: CodeHostRegistry,
  ) {}

  async execute(key: string): Promise<PipelineResult> {
    const opened = await openStep(this.history, key, 'commit');
    try {
      const requirements = await this.history.latestBody(key, 'requirements');
      if (!requirements?.trim()) {
        throw new SwarmloopError('requirements is missing');
      }
      const summary = summaryForBranch(requirements, key);
      const branch = branchName(key, summary);
      const names = repoNames((await this.history.latestBody(key, 'repos')) ?? '');
      const trees = this.trees(key, names);
      await this.assertBranch(trees, branch);
      const phases = await this.history.activePhases(opened.run.id);
      const stored = await this.history.latestBody(key, 'commit');
      const again = await this.resume(opened, stored);
      if (!phases.includes('ci') && !again) {
        const body = await this.preview(trees, branch);
        return this.end(opened, 'waiting', 0, `${opened.startedAt} commit waiting\n${body.trimEnd()}`, body);
      }
      const planned = again ? parsePaths(stored ?? '') : await this.plan(trees, await this.history.listDenyPaths());
      if (planned.length === 0 && !(await this.somethingToPush(trees, branch))) {
        if (await this.publishedHead(trees, branch)) {
          return this.end(opened, 'ok', 0, `${opened.startedAt} commit done\n${branch}`);
        }
        throw new SwarmloopError('nothing to commit');
      }
      const pushed = await this.publish(trees, planned, branch, commitMessage(key, summary), opened.run.codeHost);
      const listed = planned.length > 0 ? renderPaths(planned).trimEnd() : '';
      if (!pushed) {
        await this.history.putDocument(opened.run, 'ci_skip', `${CI_SKIPPED}\n`);
        const line = listed ? `${opened.startedAt} ${CI_SKIPPED}\n${listed}` : `${opened.startedAt} ${CI_SKIPPED}`;
        return this.end(opened, 'ok', 0, line, listed ? `${listed}\n` : undefined);
      }
      const recorded = await this.rememberRefs(opened.run, trees, branch);
      if (recorded) {
        const skip = await this.history.latestBody(key, 'ci_skip');
        if (skip?.trim()) {
          await this.history.putDocument(opened.run, 'ci_skip', '');
        }
      }
      const line = listed ? `${opened.startedAt} commit done\n${branch}\n${listed}` : `${opened.startedAt} commit done\n${branch}`;
      return this.end(opened, 'ok', 0, line, listed ? `${listed}\n` : undefined);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'commit failed';
      return this.end(opened, 'failed', 1, `${opened.startedAt} ${message}`);
    }
  }

  /** A failed or still-open commit retries its own path list. Arriving from the previous phase reads the tree again. */
  private async resume(opened: OpenedStep, stored: string | null): Promise<boolean> {
    if (!stored?.trim() || opened.previousStep !== 'commit') {
      return false;
    }
    if (opened.previousStatus === 'failed' || opened.previousStatus === 'running') {
      return true;
    }
    if (opened.previousStatus !== 'waiting') {
      return false;
    }
    const stats = await this.history.listStats(opened.run.id);
    const last = [...stats].reverse().find((item) => item.step === 'commit');
    return last?.status === 'waiting';
  }

  private trees(key: string, names: string[]): Tree[] {
    return names.map((repo) => {
      const path = worktreePath(this.history.root(), key, repo);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new SwarmloopError(`${repo} is not a worktree`);
      }
      return { repo, path };
    });
  }

  private async assertBranch(trees: Tree[], branch: string): Promise<void> {
    for (const tree of trees) {
      const current = await this.gitAt(tree, ['branch', '--show-current'], 'branch failed');
      if (current === 'main' || current === 'master') {
        throw new SwarmloopError(`${tree.repo} branch is protected`);
      }
      if (current !== branch) {
        throw new SwarmloopError(`${tree.repo} branch is missing`);
      }
    }
  }

  private async preview(trees: Tree[], branch: string): Promise<string> {
    const planned = await this.plan(trees, await this.history.listDenyPaths());
    if (planned.length > 0) {
      return renderPaths(planned);
    }
    const pending: string[] = [];
    for (const tree of trees) {
      if (await this.ahead(tree, branch)) {
        pending.push(tree.repo);
      }
    }
    if (pending.length === 0) {
      throw new SwarmloopError('nothing to commit');
    }
    return `${pending.join('\n')}\n`;
  }

  private async plan(trees: Tree[], denied: string[]): Promise<PlannedPath[]> {
    const planned: PlannedPath[] = [];
    for (const tree of trees) {
      planned.push(...allowedPaths(tree.repo, await this.status(tree), denied));
    }
    return planned;
  }

  private async ahead(tree: Tree, branch: string): Promise<boolean> {
    const head = await this.gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
    const remote = await this.optionalRev(tree, `refs/remotes/origin/${branch}`);
    if (remote) {
      return remote !== head;
    }
    const base = (await this.optionalRev(tree, 'refs/remotes/origin/main')) ?? (await this.optionalRev(tree, 'refs/remotes/origin/master'));
    return base !== head;
  }

  private async optionalRev(tree: Tree, ref: string): Promise<string | null> {
    try {
      return await git(['-C', tree.path, 'rev-parse', '--verify', '--quiet', ref]);
    } catch (error) {
      if (gitMissing(error)) {
        return null;
      }
      throw new SwarmloopError(`${tree.repo} branch failed: ${gitDetail(error)}`);
    }
  }

  private async publishedHead(trees: Tree[], branch: string): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      if (!(await originUrl(cwd, tree.repo, 'origin failed'))) {
        continue;
      }
      const remote = await this.optionalRev(tree, `refs/remotes/origin/${branch}`);
      if (!remote) {
        continue;
      }
      const head = await this.gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
      if (remote === head) {
        return true;
      }
    }
    return false;
  }

  private async somethingToPush(trees: Tree[], branch: string): Promise<boolean> {
    for (const tree of trees) {
      const cwd = tree.path;
      if ((await originUrl(cwd, tree.repo, 'origin failed')) && (await this.ahead(tree, branch))) {
        return true;
      }
    }
    return false;
  }

  private async publish(trees: Tree[], planned: PlannedPath[], branch: string, message: string, codeHost: string): Promise<boolean> {
    const denied = await this.history.listDenyPaths();
    const pushed = await Promise.all(trees.map((tree) => this.publishTree(tree, planned, branch, message, denied, codeHost)));
    return pushed.some(Boolean);
  }

  private async publishTree(
    tree: Tree,
    planned: PlannedPath[],
    branch: string,
    message: string,
    denied: string[],
    codeHost: string,
  ): Promise<boolean> {
    const cwd = tree.path;
    const wanted = new Set(planned.filter((item) => item.repo === tree.repo).map((item) => item.path));
    const porcelain = await this.status(tree);
    const held = deniedIndexPaths(porcelain, denied);
    if (held.length > 0) {
      await this.gitAt(tree, ['reset', '-q', 'HEAD', '--', ...held], 'commit failed');
    }
    const selection = stageSelection(porcelain, denied);
    const add = selection.add.filter((path) => wanted.has(path));
    const staged = selection.staged.filter((path) => wanted.has(path));
    if (add.length > 0) {
      await this.gitAt(tree, ['add', '--', ...add], 'commit failed');
    }
    if (add.length > 0 || staged.length > 0) {
      await this.gitAt(tree, [...(await authorArgs(cwd)), 'commit', '--no-verify', '-m', message], 'commit failed');
    }
    const origin = await originUrl(cwd, tree.repo, 'origin failed');
    if (!origin) {
      return false;
    }
    const published = await this.optionalRev(tree, `refs/remotes/origin/${branch}`);
    return this.pushRef(tree, branch, published, codeHost, origin);
  }

  /** Push a rewritten branch with the tip captured before the base fetch. Does not stage or commit. */
  async publishRebased(key: string, branch: string, leases: { repo: string; tip: string | null }[]): Promise<void> {
    const run = await this.history.findRun(key);
    if (!run) {
      throw new SwarmloopError(`${key} is missing`);
    }
    const trees = this.trees(key, leases.map((lease) => lease.repo));
    for (const tree of trees) {
      const cwd = tree.path;
      const origin = await originUrl(cwd, tree.repo, 'origin failed');
      if (!origin) {
        continue;
      }
      const captured = leases.find((lease) => lease.repo === tree.repo)?.tip ?? null;
      await this.pushRef(tree, branch, captured, run.codeHost, origin);
    }
    await this.rememberRefs(run, trees, branch);
  }

  private async pushRef(tree: Tree, branch: string, published: string | null, codeHost: string, origin: string): Promise<boolean> {
    const lease = published ? [`--force-with-lease=refs/heads/${branch}:${published}`] : [];
    if (!this.registry.has(codeHost)) {
      if (origin.startsWith('git@') || origin.startsWith('ssh://')) {
        throw new SwarmloopError('code host is missing');
      }
      await this.gitAt(tree, ['push', ...lease, '-u', 'origin', branch], 'push failed');
      return true;
    }
    const host = this.registry.credentials(codeHost);
    const url = this.registry.byName(codeHost).pushUrl(origin);
    if (url) {
      await this.gitAt(tree, ['-c', `remote.origin.pushurl=${url}`, 'push', ...lease, 'origin', `HEAD:refs/heads/${branch}`], 'push failed', { GIT_TERMINAL_PROMPT: '0' }, host.token);
      await this.gitAt(tree, ['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], 'push failed');
      return true;
    }
    if (origin.startsWith('git@') || origin.startsWith('ssh://')) {
      if (!host.token.trim()) {
        throw new SwarmloopError(`${tree.repo} push failed: ${host.tokenKey} is missing`);
      }
      if (!host.baseUrl.trim()) {
        throw new SwarmloopError(`${tree.repo} push failed: ${host.baseKey} is missing`);
      }
      throw new SwarmloopError(`${tree.repo} origin is not ${host.baseKey}`);
    }
    await this.gitAt(tree, ['push', ...lease, '-u', 'origin', branch], 'push failed');
    return true;
  }

  /** True when this push recorded a host project. A filesystem origin does not. */
  private async rememberRefs(run: RunEntity, trees: Tree[], branch: string): Promise<boolean> {
    const blocks: string[] = [];
    for (const tree of trees) {
      const cwd = tree.path;
      const url = await originUrl(cwd, tree.repo, 'origin failed');
      if (!url) {
        continue;
      }
      let project = '';
      try {
        project = remoteProject(url).project;
      } catch {
        continue;
      }
      const sha = await this.gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
      blocks.push(`project: ${project}\nref: ${branch}\nsha: ${sha}`);
    }
    if (blocks.length === 0) {
      return false;
    }
    await this.history.putDocument(run, 'pipeline_ref', `${blocks.join('\n\n')}\n`);
    return true;
  }

  private async status(tree: Tree): Promise<string> {
    try {
      return await gitRaw(['-C', tree.path, 'status', '--porcelain=v1', '-z', '-uall']);
    } catch (error) {
      throw new SwarmloopError(`${tree.repo} status failed: ${gitDetail(error)}`);
    }
  }

  private async gitAt(tree: Tree, args: string[], failure: string, env?: NodeJS.ProcessEnv, secret?: string): Promise<string> {
    try {
      return await git(['-C', tree.path, ...args], env);
    } catch (error) {
      const detail = gitDetail(error);
      const redacted = redact(detail, secret);
      throw new SwarmloopError(`${tree.repo} ${failure}: ${redacted}`);
    }
  }

  private async end(opened: OpenedStep, outcome: 'ok' | 'failed' | 'waiting', exitCode: number, line: string, body?: string): Promise<PipelineResult> {
    const note = outcome === 'ok' ? await recordHandoff(this.history, opened.run.key, 'commit', body?.trim() ? body : '- committed the branch\n') : null;
    const primary = body ? textDocument('commit', body) : null;
    return closeStep({
      history: this.history,
      run: opened.run,
      previousStep: opened.previousStep,
      previousStatus: opened.previousStatus,
      step: 'commit',
      outcome,
      exitCode,
      line,
      visit: {
        ...visit(opened, visitStatus(outcome), exitCode, body),
        document: note ? null : primary,
        documents: note ? [...(primary ? [primary] : []), note] : undefined,
      },
    });
  }
}

function visit(opened: OpenedStep, status: string, exitCode: number, body?: string): VisitDraft {
  return {
    step: 'commit',
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
    document: body ? textDocument('commit', body) : null,
    resumed: false,
  };
}
