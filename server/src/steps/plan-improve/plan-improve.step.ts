import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { readSession } from '../../agent/agent-runner';
import { sessionFileName } from '../../history/session-group';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { withHandoff } from '../shared/handoff';
import { plainSummary, PLAN_EXECUTION_RULE, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { storedPlan } from '../step';
import { readPlan, reviewedItems, withPlan } from '../plan/plan-record';
import { PLAN_IMPROVE_FOLLOW_UP } from './plan-improve.prompts';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  repos: lateInput(ARTIFACTS.repos),
  addedRepos: lateInput(ARTIFACTS.addedRepos),
  instructions: instructionsInput('plan-improve'),
} as const satisfies InputSpec;

@Injectable()
export class PlanImproveStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'plan-improve';
  readonly outputs = [ARTIFACTS.requirements];

  constructor(kernel: StepKernel, sandbox: SandboxService, launcher: AgentLauncher) {
    super(kernel, sandbox, launcher);
  }

  protected profile(env: SwarmloopEnv): AgentProfile {
    return {
      runtime: env.RUNTIME,
      model: env.MODEL_PLAN,
      mode: 'plan',
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
    const continued = await readSession(
      join(root(this.config), 'data', sessionFileName(key, 'plan-improve')),
      ctx.opened.run.runtime,
    );
    const full = skillPrompt(
      'plan-improve',
      input.requirements,
      names,
      withHandoff([{ heading: 'Plan', body: JSON.stringify(plan, null, 2) }], prior),
      mounts,
    );
    const chosen = continued?.chatId ? PLAN_IMPROVE_FOLLOW_UP : full;
    const prompt = withAddedRepos(chosen, await ctx.reread(ARTIFACTS.addedRepos));
    const agentResult = await ctx.launch({ prompt: `${prompt}\n\n${PLAN_EXECUTION_RULE}`, mounts });
    const items = reviewedItems(agentResult.responseText, agentResult.output ?? '');
    const next = { ...plan, items: items.length > 0 ? items : plan.items, decision: 'approve' as const };
    const summary = summaryOr(
      agentResult.responseText,
      plainSummary(agentResult.responseText) || next.items.map((item) => `- ${item}`).join('\n'),
    );
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} plan-improve done\n${next.items.join('\n')}`,
      outputs: [{ artifact: ARTIFACTS.requirements, value: withPlan(requirements, next) }],
      handoff: summary,
    };
  }
}
