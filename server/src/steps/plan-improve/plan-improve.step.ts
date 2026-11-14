import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, Route, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { isEffort } from '../../contract/effort';
import { isSubtask } from '../../contract/subtask';
import { clearEpic, markEpic } from '../../history/run-state';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { projectRules } from '../shared/project-rules';
import { AgentLauncher } from '../shared/agent-launcher';
import { appendImpact, withHandoff, withImpact } from '../shared/handoff';
import { PLAN_EXECUTION_RULE, skillPrompt } from '../shared/skill-prompt';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { storedPlan } from '../step';
import { renderSummary, withPlan } from '../plan/plan-record';
import {
  buildGraph,
  isSplit,
  planItemsFromTasks,
  splitLimits,
  splitOutputs,
  taskErrors,
  type TaskLimits,
} from '../plan/plan-tasks';
import { mergeTasks, planImproveContinue, planImproveFollowUp } from './plan-improve.prompts';
import {
  completePlanImprove,
  planImprove,
  planImproveFor,
  type PlanImproveResult,
} from '../../agent-result/definitions/plan-improve';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { currentPlan } from '../shared/current-plan';
import { renderKeep } from '../shared/keep-lines';
import { storedImpact } from '../shared/research-reads';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  repos: lateInput(ARTIFACTS.repos),
  impact: lateInput(ARTIFACTS.impact),
  researchResult: lateInput(ARTIFACTS.researchResult),
  addedRepos: lateInput(ARTIFACTS.addedRepos),
  subtasks: lateInput(ARTIFACTS.subtasks),
  contract: lateInput(ARTIFACTS.contract),
  planResult: lateInput(ARTIFACTS.planResult),
  planImproveResult: lateInput(ARTIFACTS.planImproveResult),
  implementationResult: lateInput(ARTIFACTS.implementationResult),
  implementationImproveResult: lateInput(ARTIFACTS.implementationImproveResult),
  keep: lateInput(ARTIFACTS.keep),
  instructions: instructionsInput('plan-improve'),
} as const satisfies InputSpec;

@Injectable()
export class PlanImproveStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'plan-improve';
  readonly outputs = [
    ARTIFACTS.requirements,
    ARTIFACTS.subtasks,
    ARTIFACTS.keep,
    ARTIFACTS.contract,
    ARTIFACTS.planImproveResult,
  ];

  constructor(kernel: StepKernel, sandbox: SandboxService, launcher: AgentLauncher) {
    super(kernel, sandbox, launcher);
  }

  protected profile(env: SwarmloopEnv, run?: RunEntity | null): AgentProfile {
    return {
      ...agentFor(env, run ?? null, 'plan-improve'),
      mode: 'plan',
      tools: 'plan',
      timeLimitMs: env.PLAN_TIMEOUT_MS,
      session: 'resume',
    };
  }

  override missingInput(key: string): Promise<string | null> {
    return storedPlan(this.documents, key);
  }

  protected async produce(input: StepInput<typeof INPUTS>, ctx: ModelStepContext): Promise<StepResult> {
    const { key } = ctx.opened.run;
    const { requirements } = input;
    const plan = await currentPlan(this.documents, key);
    if (!plan) {
      throw new SwarmloopError('plan is missing');
    }
    const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    const prior = await ctx.reread(ARTIFACTS.handoff);
    const { runtime } = this.profile(this.config.env, ctx.opened.run);
    const continued = await resumableChat(root(this.config), key, 'plan-improve', runtime);
    const impact = storedImpact(await ctx.reread(ARTIFACTS.researchResult), await ctx.reread(ARTIFACTS.impact));
    const limits = splitLimits(ctx.opened.run, this.config.env.SPLIT_MAX_TASKS);
    const maySplit = limits.maySplit;
    const tasks = maySplit ? ((await ctx.reread(ARTIFACTS.subtasks)) ?? []) : [];
    const contract = tasks.length > 0 ? ((await ctx.reread(ARTIFACTS.contract)) ?? '') : '';
    const keep = tasks.length > 0 ? ((await ctx.reread(ARTIFACTS.keep)) ?? []) : [];
    // A plan over the limit is merged once; a merge that still does not fit goes back to the agent like any other error.
    const oversized = tasks.length > limits.maxTasks;
    const splitSections =
      tasks.length > 0
        ? [
            { heading: 'Contract', body: contract },
            { heading: 'Tasks', body: JSON.stringify(tasks, null, 2) },
            ...(keep.length > 0 ? [{ heading: 'Keep', body: renderKeep(keep) }] : []),
            ...(oversized ? [{ heading: 'Merge', body: mergeTasks(tasks.length, limits.maxTasks) }] : []),
          ]
        : [];
    const asked = planImproveFor(maySplit);
    const fullFor = (target: string, received: string | null): string =>
      [
        skillPrompt(
          'plan-improve',
          input.requirements,
          names,
          withImpact(
            withHandoff([{ heading: 'Plan', body: JSON.stringify(plan, null, 2) }, ...splitSections], prior),
            impact,
          ),
          mounts,
          { split: maySplit, rules: projectRules(names, mounts, target, received !== null) },
        ),
        resultPromptFor(asked, received),
      ].join('\n\n');
    const added = await ctx.reread(ARTIFACTS.addedRepos);
    const finish = (prompt: string): string => `${withAddedRepos(prompt, added)}\n\n${PLAN_EXECUTION_RULE}`;
    const received = continued?.chatId ? planImprove.name : null;
    const chosen =
      received && !maySplit
        ? appendImpact(planImproveFollowUp(resultPromptFor(asked, received)), impact)
        : fullFor(runtime, received);
    const agentResult = await ctx.launch({
      prompt: finish(chosen),
      briefFor: (other) => finish(fullFor(other, null)),
      mounts,
      continuePrompt: planImproveContinue(),
      result: asked,
      check: (value) => improveErrors(completePlanImprove(value as Partial<PlanImproveResult>), limits),
    });
    const value = completePlanImprove(agentResult.resultValue as Partial<PlanImproveResult>);
    // A split answer is written back as tasks. A plan answer turns a split back into one plan, and an empty one keeps it.
    const graph = isSplit(value) ? buildGraph(value) : null;
    const items = graph ? planItemsFromTasks(graph.tasks) : value.plan;
    const next = { ...plan, items: items.length > 0 ? items : plan.items, decision: 'approve' as const };
    return {
      route: this.epicRoute(ctx.opened.run, !!graph),
      summary: `${ctx.opened.startedAt} plan-improve done\n${next.items.join('\n')}`,
      outputs: [
        { artifact: ARTIFACTS.requirements, value: withPlan(requirements, next) },
        { artifact: ARTIFACTS.planImproveResult, value },
        ...(tasks.length > 0 || graph ? splitOutputs(graph) : []),
      ],
      handoff: renderSummary(value.summary, next.items),
    };
  }

  /** A fresh split of a run marks it an epic and plans once more at the epic effort. A plan answer clears the mark. */
  private epicRoute(run: RunEntity, split: boolean): Route {
    if (!split) {
      if (run.epicAt) clearEpic(run);
      return { to: 'next' };
    }
    if (!run.epicAt && !isSubtask(run) && isEffort(this.config.env.EPIC_EFFORT)) {
      markEpic(run, this.clock.iso());
      return { to: 'jump', step: 'plan-improve' };
    }
    return { to: 'next' };
  }
}

/** What the server checks on a plan-improve answer after its schema: the split. */
function improveErrors(value: PlanImproveResult, limits: TaskLimits): string[] {
  return isSplit(value) ? taskErrors(value, limits) : [];
}
