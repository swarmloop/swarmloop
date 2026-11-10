import { agentFor } from '../../config/agents';
import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepCapabilities, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { appendImpact, withHandoff, withImpact } from '../shared/handoff';
import { plainSummary, PLAN_EXECUTION_RULE, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { unanswered } from '../shared/answers';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { planFromAgent, planQuestions, readPlan, withPlan } from './plan-record';
import { planFollowUp } from './plan.prompts';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  questions: lateInput(ARTIFACTS.questions),
  answers: lateInput(ARTIFACTS.answers),
  impact: lateInput(ARTIFACTS.impact),
  repos: { ...lateInput(ARTIFACTS.repos), need: 'start' },
  addedRepos: lateInput(ARTIFACTS.addedRepos),
  instructions: instructionsInput('plan'),
} as const satisfies InputSpec;

@Injectable()
export class PlanStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'plan';
  override readonly capabilities: StepCapabilities = { revisesRequirements: true };

  readonly outputs = [ARTIFACTS.requirements, ARTIFACTS.questions];

  constructor(kernel: StepKernel, sandbox: SandboxService, launcher: AgentLauncher) {
    super(kernel, sandbox, launcher);
  }

  protected profile(env: SwarmloopEnv): AgentProfile {
    return {
      ...agentFor(env, null, 'plan'),
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
    const impact = await ctx.reread(ARTIFACTS.impact);
    const sections = withImpact(
      withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior),
      impact,
    );
    const continued = await resumableChat(root(this.config), key, 'plan', this.profile(this.config.env).runtime);
    const full = skillPrompt('plan', input.requirements, names, sections, mounts);
    const chosen = continued?.chatId ? appendImpact(planFollowUp(answers), impact) : full;
    const prompt = withAddedRepos(chosen, await ctx.reread(ARTIFACTS.addedRepos));
    const agentResult = await ctx.launch({
      prompt: `${prompt}\n\n${PLAN_EXECUTION_RULE}`,
      mounts,
      sections: ['plan'],
      validate: (text, output) => {
        if (!planQuestions(text)) {
          planFromAgent(text, output ?? '');
        }
      },
    });
    const asked = planQuestions(agentResult.responseText);
    if (asked) {
      return {
        route: { to: 'wait', reason: 'questions are open' },
        summary: `${ctx.opened.startedAt} plan waiting\n${asked.trimEnd()}`,
        outputs: [{ artifact: ARTIFACTS.questions, value: asked }],
      };
    }
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
