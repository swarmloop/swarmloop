import { Injectable } from '@nestjs/common';
import { StepKernel } from '../step-kernel';
import { RunStop } from '../../agent/run-stop';
import { assertNotStopped } from '../../agent/step-stopped';
import { PhaseName, StepName } from '../../contract/steps';
import { CodeHost, MergeRequestRecord } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { HttpCallDraft, NothingToMerge, SwarmloopError } from '../../core/swarmloop-error';
import { GitRefusal } from '../shared/git-refusal';
import { RunNames } from '../shared/run-names';
import { baseBranch } from '../../git/base-ref';
import { checkedRepoNames, worktreePath } from '../../git/repo-names';
import { root } from '../../history/run-paths';
import { BaseStep, StepContext } from '../base-step';
import { nothingToMergeResult } from './nothing-to-merge';
import { mergeRequestDetails, renderMergeRequest } from './merge-request-record';
import { ARTIFACTS } from '../contract/artifacts';
import { lateInput } from '../agent-step';
import { renderImplementation } from '../implement/implement-record';
import { worktreesFingerprint } from '../shared/gate';
import { jumpBackToReview } from '../shared/back-to-review';
import { RunReport } from '../shared/run-report';
import { StaleReview } from '../shared/stale-review';
import { MergeRequestTemplate, type Summary } from './merge-request-template';
import { mergeRequestTrees, type Tree } from './merge-request-trees';
import { deliveredList } from './merge-request-delivery';
import { deliveryOf, toPublish } from '../contract/delivery-list';
import type { RunEntity } from '../../history/entities';
import type { AttemptFacts } from '../../contract/step-events';
import type { InputSpec, StepInput, StepResult } from '../contract/step-contract';

/** The late inputs are read where the path needs them: the goldens stop at a git error before they are read. */
const INPUTS = {
  ciSkip: { artifact: ARTIFACTS.ciSkip, need: 'optional' },
  requirements: { artifact: ARTIFACTS.requirements, need: 'start' },
  repos: { artifact: ARTIFACTS.repos, need: 'run' },
  delivery: { artifact: ARTIFACTS.delivery, need: 'optional', late: true },
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
  readonly outputs = [ARTIFACTS.mergeRequest, ARTIFACTS.rebaseMergeSkip, ARTIFACTS.commit, ARTIFACTS.delivery];

  constructor(
    kernel: StepKernel,
    private readonly registry: CodeHostRegistry,
    private readonly runStop: RunStop,
    private readonly runReport: RunReport,
    private readonly staleReview: StaleReview,
    private readonly runNames: RunNames,
    private readonly template: MergeRequestTemplate,
    private readonly refusal: GitRefusal,
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
    const entries = deliveryOf(await ctx.reread(ARTIFACTS.delivery), repos);
    const names = toPublish(entries).map((entry) => entry.repo);
    if (names.length === 0) {
      return nothingToMergeResult(opened.startedAt, await this.implementation(ctx));
    }
    const branch = await this.runNames.branchOf(opened.run, repos);
    const trees = await mergeRequestTrees(
      { config: this.config, registry: this.registry, names: this.runNames },
      opened.run,
      names,
      branch,
      baseBranch(opened.run.prompt),
      ctx.calls,
      client,
    );
    // The review judged every repository of the run, so its gate is checked against all of them, read ones too.
    const built = await this.summary(
      ctx,
      phases,
      repos.map((name) => worktreePath(root(this.config), key, name)),
    );
    if ('route' in built) {
      return built;
    }
    const skip = ((await ctx.reread(ARTIFACTS.rebaseMergeSkip)) ?? '').trim() === 'skip';
    assertNotStopped(this.runStop, key);
    const bodies = await this.template.bodies(opened.run, trees, built, await ctx.reread(ARTIFACTS.gitRulesNote));
    const { opened: done, unavailable } = await ctx.activity(
      'Open merge request',
      () =>
        this.ensure(bodies.trees, (repo) => this.runNames.title(opened.run, repo), {
          calls: ctx.calls,
          skip,
          client,
          run: opened.run,
        }),
      ({ opened: items }) =>
        items.map(({ tree, record }) => `!${record.iid} ${tree.existing ? 'reused' : 'created'}`).join(', '),
    );
    await ctx.write(
      ARTIFACTS.delivery,
      deliveredList(
        entries,
        bodies.trees,
        done.map((item) => item.tree),
      ),
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
  private async summary(
    ctx: StepContext,
    phases: readonly PhaseName[],
    paths: string[],
  ): Promise<Summary | StepResult> {
    const implementation = await this.implementation(ctx);
    if (!implementation) {
      throw new SwarmloopError('implementation is missing');
    }
    if (!phases.includes('code-review')) {
      return { text: implementation, report: false };
    }
    const fingerprint = await worktreesFingerprint(paths);
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

  private async ensure(
    trees: Tree[],
    title: (repo: string) => Promise<string>,
    { calls, skip, client, run }: { calls: HttpCallDraft[]; skip: boolean; client: CodeHost; run: RunEntity },
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
          // A title the host refuses is answered once: the title is rendered again from the answer for the second try.
          const created = await this.refusal.guard({ run, repo: tree.repo, repos: [tree.repo] }, 'title', async () =>
            client.openMergeRequest({
              project: tree.project,
              source: tree.branch,
              target: tree.target,
              title: await title(tree.repo),
              summary: tree.summary,
              draft: true,
            }),
          );
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
