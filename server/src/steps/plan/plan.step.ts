import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepCapabilities, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { isSubtask } from '../../contract/subtask';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { appendImpact, assumptions, withContract, withHandoff, withImpact } from '../shared/handoff';
import { plainSummary, PLAN_EXECUTION_RULE, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { unanswered } from '../shared/answers';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { planFromAgent, planQuestions, readPlan, withPlan } from './plan-record';
import { parseTasks, planItemsFromTasks, splitAnswer, splitLimits, splitOutputs, type TaskLimits } from './plan-tasks';
import { withNamedFileLines } from './named-file-lines';
import { planFollowUp, SUBTASK_DECIDES } from './plan.prompts';
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

  readonly outputs = [ARTIFACTS.requirements, ARTIFACTS.questions, ARTIFACTS.subtasks, ARTIFACTS.contract];

  constructor(kernel: StepKernel, sandbox: SandboxService, launcher: AgentLauncher) {
    super(kernel, sandbox, launcher);
  }

  protected profile(env: SwarmloopEnv, run?: RunEntity | null): AgentProfile {
    return {
      ...agentFor(env, run ?? null, 'plan'),
      mode: 'plan',
      tools: 'plan',
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
    const sections = withNamedFileLines(
      withContract(
        withImpact(withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior), impact),
        await this.parentContract(ctx.opened.run),
      ),
      [requirements, answers, prior, impact].join('\n'),
      mounts,
    );
    // Research shares this chat, so only a stored plan visit makes this a re-plan.
    const continued = (await this.visits.hasAgentVisit(ctx.opened.run.id, 'plan'))
      ? await resumableChat(root(this.config), key, 'plan', this.profile(this.config.env, ctx.opened.run).runtime)
      : null;
    const limits = splitLimits(ctx.opened.run, this.config.env.SPLIT_MAX_TASKS);
    const full = skillPrompt('plan', input.requirements, names, sections, mounts, { split: limits.maySplit });
    const chosen = continued?.chatId ? appendImpact(planFollowUp(answers), impact) : full;
    const prompt = withAddedRepos(chosen, await ctx.reread(ARTIFACTS.addedRepos));
    let agentResult = await ctx.launch({
      prompt: `${prompt}\n\n${PLAN_EXECUTION_RULE}`,
      mounts,
      sections: ['plan'],
      validate: (text, output) => {
        if (splitAnswer(text)) {
          parseTasks(text, limits);
        } else if (!planQuestions(text)) {
          planFromAgent(text, output ?? '');
        }
      },
    });
    const asked = planQuestions(agentResult.responseText);
    // A subtask asks no one: it decides the questions itself and records them as assumptions.
    const subtask = isSubtask(ctx.opened.run);
    if (asked && subtask) {
      agentResult = await ctx.launch({
        prompt: SUBTASK_DECIDES,
        mounts,
        sections: ['plan'],
        validate: (text, output) => planFromAgent(text, output ?? ''),
      });
    }
    if (asked && !subtask) {
      return {
        route: { to: 'wait', reason: 'questions are open' },
        summary: `${ctx.opened.startedAt} plan waiting\n${asked.trimEnd()}`,
        outputs: [{ artifact: ARTIFACTS.questions, value: asked }],
      };
    }
    const { graph, plan } = answerPlan(agentResult.responseText, agentResult.output ?? '', limits);
    const body = withPlan(requirements, plan);
    const summary = summaryOr(
      agentResult.responseText,
      plainSummary(agentResult.responseText) || plan.items.map((item) => `- ${item}`).join('\n'),
    );
    const assumed = asked && subtask ? assumptions(asked) : '';
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} plan done\n${plan.items.join('\n')}`,
      outputs: [{ artifact: ARTIFACTS.requirements, value: body }, ...(limits.maySplit ? splitOutputs(graph) : [])],
      handoff: assumed ? `${summary.trimEnd()}\n${assumed}` : summary,
    };
  }
}

/** The checklist of an answer, and its task graph when the answer is a split one. */
function answerPlan(text: string, output: string, limits: TaskLimits) {
  const graph = splitAnswer(text) ? parseTasks(text, limits) : null;
  const plan = graph
    ? { name: '', overview: '', items: planItemsFromTasks(graph.tasks), decision: null }
    : planFromAgent(text, output);
  return { graph, plan };
}
