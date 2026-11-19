import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { RunStop } from '../../agent/run-stop';
import { assertNotStopped } from '../../agent/step-stopped';
import { PhaseName, StepName } from '../../contract/steps';
import { CodeHost, MergeRequestRecord } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { HttpCallDraft, NothingToMerge, SwarmloopError } from '../../core/swarmloop-error';
import { RunNames } from '../shared/run-names';
import { baseBranch } from '../../git/base-ref';
import { checkedRepoNames } from '../../git/repo-names';
import { BaseStep, StepContext } from '../base-step';
import { nothingToMergeResult } from './nothing-to-merge';
import { mergeRequestDetails, renderMergeRequest } from './merge-request-record';
import { ARTIFACTS } from '../contract/artifacts';
import { lateInput } from '../agent-step';
import { renderImplementation } from '../implement/implement-record';
import { hasWorkToMerge } from '../shared/branch-work';
import { worktreesFingerprint } from '../shared/gate';
import { jumpBackToReview } from '../shared/back-to-review';
import { RunReport } from '../shared/run-report';
import { StaleReview } from '../shared/stale-review';
import { MergeRequestTemplate, type Summary } from './merge-request-template';
import { mergeRequestTrees, type Tree } from './merge-request-trees';
import { ref } from './merge-request-target';
import type { AttemptFacts } from '../../contract/step-events';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

/** The late inputs are read where the path needs them: the goldens stop at a git error before they are read. */
const INPUTS = {
  ciSkip: { artifact: ARTIFACTS.ciSkip, need: 'optional' },
  requirements: { artifact: ARTIFACTS.requirements, need: 'start' },
  repos: { artifact: ARTIFACTS.repos, need: 'run' },
  implementationResult: lateInput(ARTIFACTS.implementationResult),
  implementation: lateInput(ARTIFACTS.implementation),
  reviewReportResult: lateInput(ARTIFACTS.reviewReportResult),
  reviewReport: lateInput(ARTIFACTS.reviewReport),
  rebaseMergeSkip: { artifact: ARTIFACTS.rebaseMergeSkip, need: 'optional', late: true },
  gitRulesNote: lateInput(ARTIFACTS.gitRulesNote),
} as const satisfies InputSpec;

@Injectable()
export class MergeRequestStep extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'merge-request';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.mergeRequest, ARTIFACTS.rebaseMergeSkip, ARTIFACTS.commit];

  constructor(
    kernel: StepKernel,
    private readonly registry: CodeHostRegistry,
    private readonly runStop: RunStop,
    private readonly runReport: RunReport,
    private readonly staleReview: StaleReview,
    private readonly runNames: RunNames,
    private readonly template: MergeRequestTemplate,
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
    const repos = checkedRepoNames(input.repos);
    const title = await this.runNames.title(opened.run, repos[0]);
    const branch = await this.runNames.branch(opened.run, repos[0]);
    const trees = await mergeRequestTrees(
      { config: this.config, registry: this.registry, names: this.runNames },
      opened.run,
      repos,
      branch,
      baseBranch(opened.run.prompt),
      ctx.calls,
      client,
    );
    const built = await this.summary(ctx, phases, trees);
    if ('route' in built) {
      return built;
    }
    const skip = ((await ctx.reread(ARTIFACTS.rebaseMergeSkip)) ?? '').trim() === 'skip';
    const withWork = await this.withWork(trees);
    if (withWork.length === 0) {
      return nothingToMergeResult(opened.startedAt, await this.implementation(ctx));
    }
    assertNotStopped(this.runStop, key);
    const bodies = await this.template.bodies(opened.run, withWork, built, await ctx.reread(ARTIFACTS.gitRulesNote));
    const { opened: done, unavailable } = await ctx.activity(
      'Open merge request',
      () => this.ensure(bodies.trees, title, ctx.calls, skip, client),
      ({ opened: items }) =>
        items.map(({ tree, record }) => `!${record.iid} ${tree.existing ? 'reused' : 'created'}`).join(', '),
    );
    if (done.length === 0) {
      return nothingToMergeResult(opened.startedAt, await this.implementation(ctx));
    }
    if (skip) {
      await ctx.write(ARTIFACTS.rebaseMergeSkip, 'clear\n');
    }
    const records = done.map((item) => item.record);
    const urls = records.map((record) => record.url).join('\n');
    const note = `${unavailable ? '\ndrafts not available here' : ''}${bodies.errors.map((error) => `\n${error}`).join('')}`;
    return this.finish(
      `${opened.startedAt} merge-request done\n${urls}${note}`,
      renderMergeRequest(records),
      undefined,
      {
        details: mergeRequestDetails(records),
      },
    );
  }

  /** The body of the request, or the jump back to review when the report is for other files. */
  private async summary(ctx: StepContext, phases: readonly PhaseName[], trees: Tree[]): Promise<Summary | StepResult> {
    const implementation = await this.implementation(ctx);
    if (!implementation) {
      throw new SwarmloopError('implementation is missing');
    }
    if (!phases.includes('code-review')) {
      return { text: implementation, report: false };
    }
    const fingerprint = await worktreesFingerprint(trees.map((tree) => tree.path));
    const counted = await ctx.gate(ARTIFACTS.reviewReport, fingerprint);
    if (!counted) {
      const stale = await this.staleReview.reason(ctx.opened.run);
      if (!stale) {
        throw new SwarmloopError('review report is missing');
      }
      if (stale.again) {
        throw new SwarmloopError(`${stale.reason}: back to code-review`);
      }
      return jumpBackToReview(ctx, this.flows, stale.reason);
    }
    const parts = await ctx.reread(ARTIFACTS.reviewReportResult);
    const report = parts ? await this.runReport.render(ctx.opened.run) : null;
    const rendered = report ?? (await ctx.reread(ARTIFACTS.reviewReport));
    const summary = rendered?.trim() ?? '';
    if (!summary) {
      throw new SwarmloopError('review report is missing');
    }
    return { text: summary, report: report !== null };
  }

  /** What implement said it did: the lines of its stored result, else its document. Empty when it said nothing. */
  private async implementation(ctx: StepContext): Promise<string> {
    const result = await ctx.reread(ARTIFACTS.implementationResult);
    return result
      ? renderImplementation(result.implementation).trim()
      : ((await ctx.reread(ARTIFACTS.implementation))?.trim() ?? '');
  }

  /** The trees whose branch has a request already, or a commit its target does not have. */
  private async withWork(trees: Tree[]): Promise<Tree[]> {
    const kept: Tree[] = [];
    for (const tree of trees) {
      const target = tree.existing ? null : await ref(tree.repo, tree.path, `refs/remotes/origin/${tree.target}`);
      if (tree.existing || (await hasWorkToMerge(tree, target))) {
        kept.push(tree);
      }
    }
    return kept;
  }

  private async ensure(
    trees: Tree[],
    title: string,
    calls: HttpCallDraft[],
    skip: boolean,
    client: CodeHost,
  ): Promise<{ opened: { tree: Tree; record: MergeRequestRecord }[]; unavailable: boolean }> {
    const results = await Promise.all(
      trees.map(async (tree) => {
        if (tree.existing && skip) {
          return { tree, record: tree.existing, calls: [], unavailable: false };
        }
        if (tree.existing) {
          const updated = await client.updateMergeRequest(tree.project, tree.existing.iid, tree.summary);
          return {
            tree,
            record: { ...tree.existing, summary: tree.summary },
            calls: updated.httpCalls,
            unavailable: false,
          };
        }
        try {
          const created = await client.openMergeRequest({
            project: tree.project,
            source: tree.branch,
            target: tree.target,
            title,
            summary: tree.summary,
            draft: true,
          });
          return {
            tree,
            record: { ...created.record, summary: tree.summary },
            calls: created.httpCalls,
            unavailable: created.draftsUnavailable,
          };
        } catch (error) {
          if (error instanceof NothingToMerge) {
            return { tree, record: null, calls: error.httpCalls, unavailable: false };
          }
          throw error;
        }
      }),
    );
    for (const item of results) {
      calls.push(...item.calls);
    }
    const opened = results.flatMap(({ tree, record }) => (record ? [{ tree, record }] : []));
    return { opened, unavailable: results.some((item) => item.unavailable) };
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
