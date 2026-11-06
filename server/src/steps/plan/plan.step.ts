import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepCapabilities, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { readSession } from '../../agent/agent-runner';
import { sessionFileName } from '../../history/session-group';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { withHandoff } from '../shared/handoff';
import { plainSummary, PLAN_EXECUTION_RULE, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { unanswered } from '../shared/answers';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { planFromAgent, readPlan, withPlan } from './plan-record';
import { planFollowUp } from './plan.prompts';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  questions: lateInput(ARTIFACTS.questions),
  answers: lateInput(ARTIFACTS.answers),
  repos: { ...lateInput(ARTIFACTS.repos), need: 'start' },
  addedRepos: lateInput(ARTIFACTS.addedRepos),
  instructions: instructionsInput('plan'),
} as const satisfies InputSpec;

@Injectable()
export class PlanStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'plan';
  override readonly capabilities: StepCapabilities = { revisesRequirements: true };

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

  protected async produce(input: StepInput<typeof INPUTS>, ctx: ModelStepContext): Promise<StepResult> {
    const { key } = ctx.opened.run;
    const questions = (await ctx.reread(ARTIFACTS.questions)) ?? '';
    const answers = (await ctx.reread(ARTIFACTS.answers)) ?? '';
    if (unanswered(questions, answers).length > 0) {
      return {
        route: { to: 'wait', reason: 'questions are open' },
        summary: `${ctx.opened.startedAt} questions are open`,
        outputs: [],
      };
    }
    const { requirements } = input;
    const stored = readPlan(requirements);
    if (stored && stored.decision !== 'revise') {
      return {
        route: { to: 'next' },
        summary: `${ctx.opened.startedAt} plan done`,
        outputs: [{ artifact: ARTIFACTS.requirements, value: requirements }],
        handoff: stored.items.map((item) => `- ${item}`).join('\n'),
      };
    }
    const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    const prior = await ctx.reread(ARTIFACTS.handoff);
    const sections = withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior);
    const continued = await readSession(
      join(root(this.config), 'data', sessionFileName(key, 'plan')),
      ctx.opened.run.runtime,
    );
    const full = skillPrompt('plan', input.requirements, names, sections, mounts);
    const chosen = continued?.chatId ? planFollowUp(answers) : full;
    const prompt = withAddedRepos(chosen, await ctx.reread(ARTIFACTS.addedRepos));
    const agentResult = await ctx.launch({ prompt: `${prompt}\n\n${PLAN_EXECUTION_RULE}`, mounts });
    const plan = planFromAgent(agentResult.responseText, agentResult.output ?? '');
    const body = withPlan(requirements, plan);
    const summary = summaryOr(
      agentResult.responseText,
      plainSummary(agentResult.responseText) || plan.items.map((item) => `- ${item}`).join('\n'),
    );
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} plan done\n${plan.items.join('\n')}`,
      outputs: [{ artifact: ARTIFACTS.requirements, value: body }],
      handoff: summary,
    };
  }
}
