import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { HistoryService } from '../../history/history.service';
import { DocumentDraft, sampleSelf } from '../../history/visit';
import { PhaseName, PipelineResult, StepName, StepOptions, visitStatus } from '../../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../../pipeline/step-run';
import { CodeHost, MergeRequestRecord } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../../swarmloop-error';
import { branchName, summaryForBranch } from '../branch/branch-name';
import { git, gitDetail, gitMissing } from '../../git/git';
import { recordHandoff, textDocument } from '../model-step';
import { repoNames, worktreePath } from '../repo-names';
import { Step, requiredDocument } from '../step';
import { remoteProject, renderMergeRequest } from './merge-request-record';

/** Set on a done rebase so this pass leaves an existing merge request untouched. */
export const REBASE_MERGE_SKIP = 'rebase_merge_skip';

interface Tree {
  repo: string;
  path: string;
  project: string;
  branch: string;
  target: string;
  existing: MergeRequestRecord | null;
  summary: string;
}

@Injectable()
export class MergeRequestService implements Step {
  readonly name: StepName = 'merge-request';
  readonly usesModel = false;

  constructor(
    private readonly history: HistoryService,
    private readonly registry: CodeHostRegistry,
  ) {}

  missingInput(key: string): Promise<string | null> {
    return requiredDocument(this.history, key, 'requirements');
  }

  async execute(key: string, _options: StepOptions = {}): Promise<PipelineResult> {
    const opened = await openStep(this.history, key, 'merge-request');
    const calls: HttpCallDraft[] = [];
    try {
      const skipped = ((await this.history.latestBody(key, 'ci_skip')) ?? '').trim();
      if (skipped) {
        return this.finish(opened, 'ok', 0, `${opened.startedAt} ${skipped}`, calls, undefined, '');
      }
      this.registry.requiredCredentials(opened.run.codeHost);
      const client = this.registry.byName(opened.run.codeHost);
      const phases = await this.history.activePhases(opened.run.id);
      const requirements = await this.history.latestBody(key, 'requirements');
      if (!requirements?.trim()) {
        throw new SwarmloopError('requirements is missing');
      }
      const title = summaryForBranch(requirements, key);
      const branch = branchName(key, title);
      const names = repoNames((await this.history.latestBody(key, 'repos')) ?? '');
      const trees = await this.trees(key, names, branch, calls, opened.run.codeHost, client);
      const drafted = await this.describe(key, trees, phases);
      const skip = ((await this.history.latestBody(key, REBASE_MERGE_SKIP)) ?? '').trim() === 'skip';
      const records = await this.ensure(drafted, title, calls, skip, client);
      if (skip) {
        await this.history.putDocument(opened.run, REBASE_MERGE_SKIP, 'clear\n');
      }
      const body = renderMergeRequest(records);
      const urls = records.map((record) => record.url).join('\n');
      return this.finish(opened, 'ok', 0, `${opened.startedAt} merge-request done\n${urls}`, calls, body);
    } catch (error) {
      this.keepCalls(error, calls);
      const message = error instanceof SwarmloopError ? error.message : 'merge-request failed';
      return this.finish(opened, 'failed', 1, `${opened.startedAt} ${message}`, calls);
    }
  }

  private async trees(
    key: string,
    names: string[],
    branch: string,
    calls: HttpCallDraft[],
    codeHost: string,
    client: CodeHost,
  ): Promise<Tree[]> {
    const selected = this.registry.credentials(codeHost);
    const host = new URL(selected.baseUrl).hostname.toLowerCase();
    const trees: Tree[] = [];
    for (const repo of names) {
      const path = worktreePath(this.history.root(), key, repo);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new SwarmloopError(`${repo} is not a worktree`);
      }
      const current = await this.gitAt(repo, path, ['branch', '--show-current'], 'branch failed');
      if (current === 'main' || current === 'master') {
        throw new SwarmloopError(`${repo} branch is protected`);
      }
      if (current !== branch) {
        throw new SwarmloopError(`${repo} branch is missing`);
      }
      const remote = await this.ref(repo, path, `refs/remotes/origin/${branch}`);
      const head = await this.gitAt(repo, path, ['rev-parse', 'HEAD'], 'branch failed');
      if (!remote || remote !== head) {
        throw new SwarmloopError(`${repo} branch is not pushed`);
      }
      const origin = remoteProject(await this.gitAt(repo, path, ['remote', 'get-url', 'origin'], 'origin failed'));
      if (origin.host.toLowerCase() !== host) {
        throw new SwarmloopError(`${repo} origin is not ${selected.baseKey}`);
      }
      const target = await this.target(repo, path);
      if (target === branch) {
        throw new SwarmloopError(`${repo} target branch is the feature branch`);
      }
      const found = await client.findMergeRequest({ project: origin.project, source: branch });
      calls.push(...found.httpCalls);
      trees.push({ repo, path, project: origin.project, branch, target, existing: found.record, summary: '' });
    }
    return trees;
  }

  private async describe(key: string, trees: Tree[], phases: readonly PhaseName[]): Promise<Tree[]> {
    const implementation = (await this.history.latestBody(key, 'implementation'))?.trim() ?? '';
    if (!implementation) {
      throw new SwarmloopError('implementation is missing');
    }
    const summary = phases.includes('code-review') ? ((await this.history.latestBody(key, 'review_report'))?.trim() ?? '') : implementation;
    if (!summary) {
      throw new SwarmloopError('review report is missing');
    }
    return trees.map((tree) => ({ ...tree, summary }));
  }

  private async ensure(trees: Tree[], title: string, calls: HttpCallDraft[], skip: boolean, client: CodeHost): Promise<MergeRequestRecord[]> {
    const opened = await Promise.all(
      trees.map(async (tree) => {
        if (tree.existing && skip) {
          return { record: tree.existing, calls: [] };
        }
        if (tree.existing) {
          const updated = await client.updateMergeRequest(tree.project, tree.existing.iid, tree.summary);
          return { record: { ...tree.existing, summary: tree.summary }, calls: updated.httpCalls };
        }
        const created = await client.openMergeRequest({
          project: tree.project,
          source: tree.branch,
          target: tree.target,
          title,
          summary: tree.summary,
        });
        return { record: { ...created.record, summary: tree.summary }, calls: created.httpCalls };
      }),
    );
    for (const item of opened) {
      calls.push(...item.calls);
    }
    return opened.map((item) => item.record);
  }

  private async target(repo: string, path: string): Promise<string> {
    const branch = await this.defaultBranch(path);
    if (branch) {
      return branch;
    }
    for (const name of ['main', 'master']) {
      if (await this.ref(repo, path, `refs/remotes/origin/${name}`)) {
        return name;
      }
    }
    throw new SwarmloopError('target branch is missing');
  }

  private async defaultBranch(path: string): Promise<string | null> {
    try {
      const name = await git(['-C', path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const branch = name.replace(/^origin\//, '');
      return branch && branch !== 'HEAD' ? branch : null;
    } catch {
      return null;
    }
  }

  private async ref(repo: string, path: string, name: string): Promise<string | null> {
    try {
      return await git(['-C', path, 'rev-parse', '--verify', '--quiet', name]);
    } catch (error) {
      if (gitMissing(error)) {
        return null;
      }
      throw new SwarmloopError(`${repo} branch failed: ${gitDetail(error)}`);
    }
  }

  private async gitAt(repo: string, path: string, args: string[], failure: string): Promise<string> {
    try {
      return await git(['-C', path, ...args]);
    } catch (error) {
      throw new SwarmloopError(`${repo} ${failure}: ${gitDetail(error)}`);
    }
  }

  private keepCalls(error: unknown, calls: HttpCallDraft[]): void {
    if (error instanceof FetchFailed) {
      calls.push(...error.httpCalls);
    }
  }

  private async finish(
    opened: OpenedStep,
    outcome: 'ok' | 'failed',
    exitCode: number,
    line: string,
    calls: HttpCallDraft[],
    body?: string,
    handoff = '- opened the merge request\n',
  ): Promise<PipelineResult> {
    const now = new Date().toISOString();
    const docs: DocumentDraft[] = [];
    if (body) {
      docs.push(textDocument('merge_request', body));
    }
    if (outcome === 'ok' && handoff) {
      docs.push(await recordHandoff(this.history, opened.run.key, 'merge-request', handoff));
    }
    return closeStep({
      history: this.history,
      run: opened.run,
      previousStep: opened.previousStep,
      previousStatus: opened.previousStatus,
      step: 'merge-request',
      outcome,
      exitCode,
      line,
      visit: {
        step: 'merge-request',
        model: null,
        mode: null,
        startedAt: opened.startedAt,
        finishedAt: now,
        durationMs: Date.now() - opened.started,
        status: visitStatus(outcome),
        exitCode,
        killReason: null,
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        samples: [sampleSelf()],
        exchange: null,
        httpCalls: calls,
        document: null,
        documents: docs.length > 0 ? docs : undefined,
        resumed: false,
      },
    });
  }
}
