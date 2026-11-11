import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { RunStop } from '../../agent/run-stop';
import { assertNotStopped } from '../shared/step-stopped';
import { existsSync, statSync } from 'fs';
import { root } from '../../history/run-paths';
import { PhaseName, StepName } from '../../contract/steps';
import { CodeHost, MergeRequestRecord } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { HttpCallDraft, SwarmloopError } from '../../core/swarmloop-error';
import { branchName, summaryForBranch } from '../branch/branch-name';
import { baseBranch } from '../../git/base-ref';
import { git, gitDetail, gitMissing } from '../../git/git';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import { BaseStep, StepContext } from '../base-step';
import { mergeRequestDetails, remoteProject, renderMergeRequest } from './merge-request-record';
import { ARTIFACTS } from '../contract/artifacts';
import { worktreesFingerprint } from '../shared/gate';
import type { AttemptFacts } from '../../contract/step-events';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

interface Tree {
  repo: string;
  path: string;
  project: string;
  branch: string;
  target: string;
  existing: MergeRequestRecord | null;
  summary: string;
}

/** The late inputs are read where the path needs them: the goldens stop at a git error before they are read. */
const INPUTS = {
  ciSkip: { artifact: ARTIFACTS.ciSkip, need: 'optional' },
  requirements: { artifact: ARTIFACTS.requirements, need: 'start' },
  repos: { artifact: ARTIFACTS.repos, need: 'run' },
  implementation: { artifact: ARTIFACTS.implementation, need: 'optional', late: true },
  reviewReport: { artifact: ARTIFACTS.reviewReport, need: 'optional', late: true },
  rebaseMergeSkip: { artifact: ARTIFACTS.rebaseMergeSkip, need: 'optional', late: true },
} as const satisfies InputSpec;

@Injectable()
export class MergeRequestStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'merge-request';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.mergeRequest, ARTIFACTS.rebaseMergeSkip];

  constructor(
    kernel: StepKernel,
    private readonly registry: CodeHostRegistry,
    private readonly runStop: RunStop,
  ) {
    super(kernel);
  }

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    const { opened } = ctx;
    const { key } = opened.run;
    const skipped = (input.ciSkip ?? '').trim();
    if (skipped) {
      return this.finish(`${opened.startedAt} ${skipped}`, undefined, '');
    }
    const client = await this.registry.hostFor(opened.run);
    const phases = await this.flows.activePhases(opened.run.id);
    const { requirements } = input;
    if (!requirements?.trim()) {
      throw new SwarmloopError('requirements is missing');
    }
    const title = summaryForBranch(requirements, key);
    const branch = branchName(key, title);
    const trees = await this.trees(
      key,
      checkedRepoNames(input.repos),
      branch,
      baseBranch(opened.run.prompt),
      ctx.calls,
      opened.run.codeHost,
      client,
    );
    const summary = await this.summary(ctx, phases, trees);
    const skip = ((await ctx.reread(ARTIFACTS.rebaseMergeSkip)) ?? '').trim() === 'skip';
    assertNotStopped(this.runStop, key);
    const { records, unavailable } = await ctx.activity(
      'Open merge request',
      () =>
        this.ensure(
          trees.map((tree) => ({ ...tree, summary })),
          title,
          ctx.calls,
          skip,
          client,
        ),
      ({ records: done }) =>
        done.map((record, index) => `!${record.iid} ${trees[index].existing ? 'reused' : 'created'}`).join(', '),
    );
    if (skip) {
      await ctx.write(ARTIFACTS.rebaseMergeSkip, 'clear\n');
    }
    const urls = records.map((record) => record.url).join('\n');
    const note = unavailable ? '\ndrafts not available here' : '';
    return this.finish(
      `${opened.startedAt} merge-request done\n${urls}${note}`,
      renderMergeRequest(records),
      undefined,
      {
        details: mergeRequestDetails(records),
      },
    );
  }

  private async trees(
    key: string,
    names: string[],
    branch: string,
    base: string | null,
    calls: HttpCallDraft[],
    codeHost: string,
    client: CodeHost,
  ): Promise<Tree[]> {
    const selected = this.registry.credentials(codeHost);
    const host = new URL(selected.baseUrl).hostname.toLowerCase();
    const trees: Tree[] = [];
    for (const repo of names) {
      const path = worktreePath(root(this.config), key, repo);
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
      const target = base ?? (await this.target(repo, path));
      if (target === branch) {
        throw new SwarmloopError(`${repo} target branch is the feature branch`);
      }
      const found = await client.findMergeRequest({ project: origin.project, source: branch });
      calls.push(...found.httpCalls);
      trees.push({ repo, path, project: origin.project, branch, target, existing: found.record, summary: '' });
    }
    return trees;
  }

  private async summary(ctx: StepContext, phases: readonly PhaseName[], trees: Tree[]): Promise<string> {
    const implementation = (await ctx.reread(ARTIFACTS.implementation))?.trim() ?? '';
    if (!implementation) {
      throw new SwarmloopError('implementation is missing');
    }
    if (!phases.includes('code-review')) {
      return implementation;
    }
    const fingerprint = await worktreesFingerprint(trees.map((tree) => tree.path));
    const counted = await ctx.gate(ARTIFACTS.reviewReport, fingerprint);
    const summary = counted ? ((await ctx.reread(ARTIFACTS.reviewReport))?.trim() ?? '') : '';
    if (!summary) {
      throw new SwarmloopError('review report is missing');
    }
    return summary;
  }

  private async ensure(
    trees: Tree[],
    title: string,
    calls: HttpCallDraft[],
    skip: boolean,
    client: CodeHost,
  ): Promise<{ records: MergeRequestRecord[]; unavailable: boolean }> {
    const opened = await Promise.all(
      trees.map(async (tree) => {
        if (tree.existing && skip) {
          return { record: tree.existing, calls: [], unavailable: false };
        }
        if (tree.existing) {
          const updated = await client.updateMergeRequest(tree.project, tree.existing.iid, tree.summary);
          return { record: { ...tree.existing, summary: tree.summary }, calls: updated.httpCalls, unavailable: false };
        }
        const created = await client.openMergeRequest({
          project: tree.project,
          source: tree.branch,
          target: tree.target,
          title,
          summary: tree.summary,
          draft: true,
        });
        return {
          record: { ...created.record, summary: tree.summary },
          calls: created.httpCalls,
          unavailable: created.draftsUnavailable,
        };
      }),
    );
    for (const item of opened) {
      calls.push(...item.calls);
    }
    return { records: opened.map((item) => item.record), unavailable: opened.some((item) => item.unavailable) };
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

  private finish(
    line: string,
    body?: string,
    handoff = '- opened the merge request\n',
    facts?: AttemptFacts,
  ): StepResult {
    return {
      ...(facts ? { facts } : {}),
      route: { to: 'next' },
      summary: line,
      outputs: body ? [{ artifact: ARTIFACTS.mergeRequest, value: body }] : [],
      handoff: handoff || undefined,
    };
  }
}
