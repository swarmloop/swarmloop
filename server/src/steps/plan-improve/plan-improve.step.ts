import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
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
import { plainSummary, PLAN_EXECUTION_RULE, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { storedPlan } from '../step';
import { parsePlan, readPlan, reviewedItems, withPlan } from '../plan/plan-record';
import { parseTasks, planItemsFromTasks, splitAnswer, splitLimits, splitOutputs } from '../plan/plan-tasks';
import { PLAN_IMPROVE_FOLLOW_UP } from './plan-improve.prompts';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  repos: lateInput(ARTIFACTS.repos),
  impact: lateInput(ARTIFACTS.impact),
  addedRepos: lateInput(ARTIFACTS.addedRepos),
  subtasks: lateInput(ARTIFACTS.subtasks),
  contract: lateInput(ARTIFACTS.contract),
  instructions: instructionsInput('plan-improve'),
} as const satisfies InputSpec;

@Injectable()
export class PlanImproveStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'plan-improve';
  readonly outputs = [ARTIFACTS.requirements, ARTIFACTS.subtasks, ARTIFACTS.contract];

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
    const plan = readPlan(requirements);
    if (!plan) {
      throw new SwarmloopError('plan is missing');
    }
    const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    const prior = await ctx.reread(ARTIFACTS.handoff);
    const { runtime } = this.profile(this.config.env, ctx.opened.run);
    const continued = await resumableChat(root(this.config), key, 'plan-improve', runtime);
    const impact = await ctx.reread(ARTIFACTS.impact);
    const limits = splitLimits(ctx.opened.run, this.config.env.SPLIT_MAX_TASKS);
    const maySplit = limits.maySplit;
    const tasks = maySplit ? ((await ctx.reread(ARTIFACTS.subtasks)) ?? []) : [];
    const contract = tasks.length > 0 ? ((await ctx.reread(ARTIFACTS.contract)) ?? '') : '';
    const splitSections =
      tasks.length > 0
        ? [
            { heading: 'Contract', body: contract },
            { heading: 'Tasks', body: JSON.stringify(tasks, null, 2) },
          ]
        : [];
    const fullFor = (target: string, received: boolean): string =>
      skillPrompt(
        'plan-improve',
        input.requirements,
        names,
        withImpact(
          withHandoff([{ heading: 'Plan', body: JSON.stringify(plan, null, 2) }, ...splitSections], prior),
          impact,
        ),
        mounts,
        { split: maySplit, rules: projectRules(names, mounts, target, received) },
      );
    const added = await ctx.reread(ARTIFACTS.addedRepos);
    const finish = (prompt: string): string => `${withAddedRepos(prompt, added)}\n\n${PLAN_EXECUTION_RULE}`;
    const chosen =
      continued?.chatId && !maySplit
        ? appendImpact(PLAN_IMPROVE_FOLLOW_UP, impact)
        : fullFor(runtime, !!continued?.chatId);
    const agentResult = await ctx.launch({
      prompt: finish(chosen),
      // A chat the CLI no longer has starts anew with the rules the full prompt left out.
      freshPrompt: continued?.chatId && maySplit ? finish(fullFor(runtime, false)) : undefined,
      briefFor: (other) => finish(fullFor(other, false)),
      mounts,
      sections: ['plan'],
      validate: (text) => (splitAnswer(text) ? parseTasks(text, limits) : parsePlan(text)),
    });
    // A split answer is written back as tasks. A plan answer turns a split back into one plan.
    const graph = splitAnswer(agentResult.responseText) ? parseTasks(agentResult.responseText, limits) : null;
    const items = graph
      ? planItemsFromTasks(graph.tasks)
      : reviewedItems(agentResult.responseText, agentResult.output ?? '');
    const next = { ...plan, items: items.length > 0 ? items : plan.items, decision: 'approve' as const };
    const summary = summaryOr(
      agentResult.responseText,
      plainSummary(agentResult.responseText) || next.items.map((item) => `- ${item}`).join('\n'),
    );
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} plan-improve done\n${next.items.join('\n')}`,
      outputs: [
        { artifact: ARTIFACTS.requirements, value: withPlan(requirements, next) },
        ...(tasks.length > 0 || graph ? splitOutputs(graph) : []),
      ],
      handoff: summary,
    };
  }
}
