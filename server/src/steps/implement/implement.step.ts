import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { CheckoutRepository } from '../../history/checkout.repository';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { isSubtask, settled, withStatuses } from '../../contract/subtask';
import { StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { branchName, summaryForBranch } from '../branch/branch-name';
import { isChecksReturn, isPipelineReturn, withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { RebasedPublisher } from '../shared/rebased-publisher';
import {
  pipelineAnswers,
  returnedNotes,
  textDocument,
  withContract,
  withHandoff,
  withSubtasks,
} from '../shared/handoff';
import { projectRules } from '../shared/project-rules';
import { skillPrompt } from '../shared/skill-prompt';
import { currentPlan } from '../shared/current-plan';
import { correctedPlan, renderSummary, requireApprovedPlan } from '../plan/plan-record';
import { implementation, type ImplementationResult } from '../../agent-result/definitions/implementation';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { EnvironmentService } from '../../environment/environment.service';
import { withEnvironment } from '../../environment/environment-note';
import { agentWorkplace, projectFor } from '../shared/agent-environment';
import { storedPlan } from '../step';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import { settleRebase, type RebaseDeps } from './implement-rebase';
import { assertUncommitted, featureHeads, worktreeSnapshot, worktreeStatus } from '../../git/worktree-git';
import { unchangedSincePipeline } from '../pipeline/pipeline-report';
import { rerunFailed } from './failed-commands';
import { checksStillRed, implementFollowUp } from './implement.prompts';
import { implementNeedsWait } from './implement-needs';
import { renderCause, renderImplementation, withReturnNotes } from './implement-record';
import { retryUnchangedPipeline } from './implement-pipeline-return';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepSnapshot } from '../step';
import type { PipelineResult } from '../../core/pipeline-result';
import { SplitImplementStep } from './split-implement.step';

/** The follow-ups a checks return gets in one visit while its failed commands are still red. */
const MAX_CHECK_FOLLOW_UPS = 2;

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  planResult: lateInput(ARTIFACTS.planResult),
  planImproveResult: lateInput(ARTIFACTS.planImproveResult),
  implementationResult: lateInput(ARTIFACTS.implementationResult),
  implementationImproveResult: lateInput(ARTIFACTS.implementationImproveResult),
  returns: lateInput(ARTIFACTS.issues),
  repos: lateInput(ARTIFACTS.repos),
  rebaseConflict: lateInput(ARTIFACTS.rebaseConflict),
  addedRepos: lateInput(ARTIFACTS.addedRepos),
  pipelineRef: lateInput(ARTIFACTS.pipelineRef),
  instructions: instructionsInput('implement'),
} as const satisfies InputSpec;

@Injectable()
export class ImplementStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'implement';
  readonly outputs = [
    ARTIFACTS.implementation,
    ARTIFACTS.implementationResult,
    ARTIFACTS.rebaseResolutionResult,
    ARTIFACTS.requirements,
    ARTIFACTS.pipelineRef,
    ARTIFACTS.ciRerun,
    ARTIFACTS.unfixedIssue,
    ARTIFACTS.rebaseConflict,
    ARTIFACTS.rebaseMergeSkip,
    ARTIFACTS.subtasks,
    ARTIFACTS.contract,
    ARTIFACTS.subtaskQuestions,
    ARTIFACTS.needs,
  ];

  constructor(
    kernel: StepKernel,
    sandbox: SandboxService,
    private readonly publisher: RebasedPublisher,
    private readonly checkouts: CheckoutRepository,
    launcher: AgentLauncher,
    private readonly environments: EnvironmentService,
    private readonly split: SplitImplementStep,
  ) {
    super(kernel, sandbox, launcher);
  }

  /**
   * The implement of a run the planner split is the server's passes over its subtasks, not an agent. Once every task
   * is settled, a return from a later step or a rebase conflict is fixed by the agent on the merged feature branch.
   */
  override async execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    const run = await this.runs.findRun(key);
    const tasks = run?.split ? await this.reader.reread(key, ARTIFACTS.subtasks) : null;
    if (!run || !tasks?.length) {
      return super.execute(key, options, snapshot);
    }
    const marker = ((await this.reader.reread(key, ARTIFACTS.rebaseConflict)) ?? '').trim();
    const fixing =
      withStatuses(tasks).every(settled) &&
      (marker.startsWith('pending') || !!(await returnedNotes(this.documents, run.id)));
    return fixing ? super.execute(key, options, snapshot) : this.split.execute(key, options, snapshot);
  }

  override missingInput(key: string): Promise<string | null> {
    return storedPlan(this.documents, key);
  }

  protected profile(env: SwarmloopEnv, run?: RunEntity | null): AgentProfile {
    return {
      ...agentFor(env, run ?? null, 'implement'),
      mode: 'agent',
      tools: 'write',
      timeLimitMs: env.IMPLEMENT_TIMEOUT_MS,
      session: 'resume',
    };
  }

  protected async produce(
    input: StepInput<typeof INPUTS>,
    ctx: ModelStepContext,
    options: StepOptions,
  ): Promise<StepResult> {
    const env = this.config.env;
    const { key } = ctx.opened.run;
    const auto = options.auto;
    const current = await currentPlan(this.documents, key);
    const plan = requireApprovedPlan(current);
    const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    if (auto && ctx.opened.run.agentCalls + 1 > env.MAX_AGENT_CALLS) {
      return {
        route: { to: 'block', reason: 'implement does not fit' },
        summary: `${ctx.opened.startedAt} implement does not fit`,
        outputs: [],
      };
    }
    const notes = await returnedNotes(this.documents, ctx.opened.run.id);
    const merged = ctx.opened.run.split
      ? withSubtasks(withContract([], await ctx.reread(ARTIFACTS.contract)), await ctx.reread(ARTIFACTS.subtasks))
      : [];
    const sections = [
      ...withHandoff(withReturnNotes([{ heading: 'Plan', body: plan }], notes), await ctx.reread(ARTIFACTS.handoff)),
      ...merged,
    ];
    const branch = branchName(key, summaryForBranch(input.requirements, key));
    const markerBody = ((await ctx.reread(ARTIFACTS.rebaseConflict)) ?? '').trim();
    const marker = markerBody.split('\n')[0]?.trim() ?? '';
    const storedStderr = markerBody.split('\n').slice(1).join('\n').trim();
    const { runtime } = this.profile(env, ctx.opened.run);
    const fullFor = (target: string): string =>
      [
        skillPrompt('implement', input.requirements, names, sections, mounts, {
          deferExecutionRules: true,
          rules: projectRules(names, mounts, target, false),
        }),
        resultPromptFor(implementation, null),
      ].join('\n\n');
    const full = fullFor(runtime);
    const added = await ctx.reread(ARTIFACTS.addedRepos);
    const settled = await settleRebase(
      this.rebaseDeps(runtime),
      input.requirements,
      ctx,
      marker,
      names,
      branch,
      storedStderr,
    );
    if (settled) {
      return settled;
    }
    const continued = await resumableChat(root(this.config), key, 'implement', runtime);
    const received = continued?.chatId ? (continued.resultName ?? null) : null;
    const basePrompt = withAddedRepos(
      continued?.chatId ? implementFollowUp(plan, notes, merged, received) : full,
      added,
    );
    const heads = await featureHeads(mounts, branch);
    const place = { run: ctx.opened.run, key, step: this.name, mounts, runtime, samples: ctx.samples };
    const reproject = projectFor(this.environments, place);
    const { prompt, project, allowHosts, manifestHosts, executionRules } = await agentWorkplace(
      this.environments,
      place,
      basePrompt,
    );
    const before = await worktreeSnapshot(mounts);
    const asked = (value: unknown): string[] => implementErrors(ctx.opened.run, value as ImplementationResult);
    const first = await ctx.launch({
      prompt,
      mounts,
      allowHosts,
      manifestHosts,
      project,
      projectFor: reproject,
      briefFor: (other) => withEnvironment(withAddedRepos(fullFor(other), added), executionRules),
      result: implementation,
      check: asked,
      freshPrompt: continued?.chatId ? withEnvironment(withAddedRepos(full, added), executionRules) : undefined,
    });
    await assertUncommitted(mounts, branch, heads);
    let value = first.resultValue as ImplementationResult;
    const waiting = implementNeedsWait(ctx.opened.run, ctx.opened.startedAt, value);
    if (waiting) {
      return { ...waiting, outputs: [...waiting.outputs, { artifact: ARTIFACTS.implementationResult, value }] };
    }
    if (isSubtask(ctx.opened.run)) await ctx.write(ARTIFACTS.needs, '');
    // The newest checklist an answer of this visit corrected.
    let corrected = value.plan?.length ? value.plan : undefined;
    const unchanged = async (): Promise<boolean> =>
      (await unchangedSincePipeline(await ctx.reread(ARTIFACTS.pipelineRef), mounts)) ??
      (await worktreeSnapshot(mounts)) === before;
    const sameWorkplace = { mounts, allowHosts, manifestHosts, project, projectFor: reproject };
    const pipelineReturn = isPipelineReturn(notes);
    const { issues, unfixed } = pipelineReturn
      ? await pipelineAnswers(this.documents, ctx.opened.run.id)
      : { issues: [], unfixed: new Set<string>() };
    if (pipelineReturn && (await unchanged())) {
      const outcome = await retryUnchangedPipeline(
        {
          ctx,
          events: this.kernel.stepEvents,
          step: this.name,
          requirements: input.requirements,
          items: current?.items ?? [],
          plan: corrected,
          notes,
          issues,
          unfixed,
          mounts,
          workplace: sameWorkplace,
          executionRules,
          unchanged,
          assertUncommitted: () => assertUncommitted(mounts, branch, heads),
        },
        value,
      );
      if ('stop' in outcome) {
        return outcome.stop;
      }
      ({ value, plan: corrected } = outcome);
    }
    let red =
      isChecksReturn(notes) || pipelineReturn
        ? await rerunFailed(this.environments, await ctx.reread(ARTIFACTS.issues), place)
        : [];
    for (let sent = 0; red.length > 0 && sent < MAX_CHECK_FOLLOW_UPS; sent++) {
      const again = await ctx.launch({
        ...sameWorkplace,
        prompt: withEnvironment(checksStillRed(red, implementation.name), executionRules),
        result: implementation,
        check: asked,
      });
      await assertUncommitted(mounts, branch, heads);
      value = again.resultValue as ImplementationResult;
      corrected = value.plan?.length ? value.plan : corrected;
      red = await this.environments.rerun(place, red);
    }
    const body = renderImplementation(value.implementation);
    const change = correctedPlan(input.requirements, corrected, current?.items ?? []);
    const reasons = renderSummary(value.summary, value.implementation);
    const why = change ? `${reasons.trimEnd()}\n${change.handoff}` : reasons;
    const summary = value.cause?.length ? `${renderCause(value.cause)}${why}` : why;
    const status = await worktreeStatus(mounts);
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
      outputs: [
        { artifact: ARTIFACTS.implementation, value: body },
        // The checklist in force goes with the result, so a later result without a correction keeps it for `currentPlan`.
        { artifact: ARTIFACTS.implementationResult, value: { ...value, plan: corrected ?? current?.items } },
      ],
      handoff: summary,
      visit: change ? { documents: [textDocument(ARTIFACTS.requirements.kind, change.requirements)] } : undefined,
    };
  }

  private rebaseDeps(runtime: RuntimeName): RebaseDeps {
    return {
      config: this.config,
      documents: this.documents,
      flows: this.flows,
      checkouts: this.checkouts,
      publisher: this.publisher,
      environments: this.environments,
      step: this.name,
      runtime,
    };
  }
}

/** What the server checks on an implement answer after its schema: it changed something, or a subtask waits for a sibling. */
function implementErrors(run: RunEntity, value: ImplementationResult): string[] {
  const errors: string[] = [];
  if (value.implementation.length === 0 && !(isSubtask(run) && value.needs?.length)) {
    errors.push('implementation: must list what you changed');
  }
  return errors;
}
