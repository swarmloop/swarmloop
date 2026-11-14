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
import { projectRules } from '../shared/project-rules';
import { AgentLauncher } from '../shared/agent-launcher';
import { appendImpact, assumptions, withContract, withHandoff, withImpact } from '../shared/handoff';
import { PLAN_EXECUTION_RULE, skillPrompt } from '../shared/skill-prompt';
import { unanswered } from '../shared/answers';
import { storedImpact } from '../shared/research-reads';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { planFields, readPlan, renderSummary, withPlan } from './plan-record';
import { renderQuestions } from '../research/research-record';
import {
  buildGraph,
  isSplit,
  planItemsFromTasks,
  splitLimits,
  splitOutputs,
  taskErrors,
  unbounded,
  type TaskLimits,
} from './plan-tasks';
import { withNamedFileLines } from './named-file-lines';
import { completePlan, plan, planFor, planShapeError, type PlanResult } from '../../agent-result/definitions/plan';
import { research } from '../../agent-result/definitions/research';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { needsWait } from '../shared/needs';
import { planContinue, planFollowUp, subtaskDecides } from './plan.prompts';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  questions: lateInput(ARTIFACTS.questions),
  answers: lateInput(ARTIFACTS.answers),
  impact: lateInput(ARTIFACTS.impact),
  researchResult: lateInput(ARTIFACTS.researchResult),
  planResult: lateInput(ARTIFACTS.planResult),
  repos: { ...lateInput(ARTIFACTS.repos), need: 'start' },
  addedRepos: lateInput(ARTIFACTS.addedRepos),
  instructions: instructionsInput('plan'),
} as const satisfies InputSpec;

@Injectable()
export class PlanStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'plan';
  override readonly capabilities: StepCapabilities = { revisesRequirements: true };

  readonly outputs = [
    ARTIFACTS.requirements,
    ARTIFACTS.questions,
    ARTIFACTS.subtasks,
    ARTIFACTS.keep,
    ARTIFACTS.contract,
    ARTIFACTS.needs,
    ARTIFACTS.planResult,
  ];

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
    const researched = await ctx.reread(ARTIFACTS.researchResult);
    const planned = await ctx.reread(ARTIFACTS.planResult);
    if (unanswered(questions, [researched, planned], answers).length > 0) {
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
    const impact = storedImpact(researched, await ctx.reread(ARTIFACTS.impact));
    const sections = withNamedFileLines(
      withContract(
        withImpact(withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior), impact),
        await this.parentContract(ctx.opened.run),
      ),
      [requirements, answers, prior, impact].join('\n'),
      mounts,
    );
    // Research shares this chat, so only a stored plan visit makes this a re-plan. The chat holds the result prompt of
    // research until then, and the one of plan after it.
    const { runtime } = this.profile(this.config.env, ctx.opened.run);
    const chat = await resumableChat(root(this.config), key, 'plan', runtime);
    const planVisit = await this.visits.hasAgentVisit(ctx.opened.run.id, 'plan');
    const continued = planVisit ? chat : null;
    const received = chat?.chatId ? (planVisit ? plan.name : research.name) : null;
    const limits = splitLimits(ctx.opened.run, this.config.env.SPLIT_MAX_TASKS);
    const added = await ctx.reread(ARTIFACTS.addedRepos);
    const subtask = isSubtask(ctx.opened.run);
    const asked = planFor({ split: limits.maySplit, subtask });
    const fullFor = (target: string, chatReceived: string | null): string =>
      [
        skillPrompt('plan', input.requirements, names, sections, mounts, {
          split: limits.maySplit,
          rules: projectRules(names, mounts, target, chatReceived !== null),
        }),
        resultPromptFor(asked, chatReceived),
      ].join('\n\n');
    const finish = (prompt: string): string => `${withAddedRepos(prompt, added)}\n\n${PLAN_EXECUTION_RULE}`;
    const chosen = continued?.chatId
      ? appendImpact(planFollowUp(answers, resultPromptFor(asked, received)), impact)
      : fullFor(runtime, received);
    const first = await ctx.launch({
      prompt: finish(chosen),
      briefFor: (other) => finish(fullFor(other, null)),
      mounts,
      continuePrompt: planContinue(),
      result: asked,
      check: (value) => planErrors(completePlan(value as Partial<PlanResult>), limits, subtask),
    });
    let result = completePlan(first.resultValue as Partial<PlanResult>);
    const needs = subtask ? (result.needs ?? []) : [];
    if (needs.length > 0) {
      const wait = needsWait(ctx.opened.startedAt, needs);
      return { ...wait, outputs: [...wait.outputs, { artifact: ARTIFACTS.planResult, value: result }] };
    }
    if (subtask) await ctx.write(ARTIFACTS.needs, '');
    const questionText = renderQuestions(result.questions);
    // A subtask asks no one: it decides the questions itself and records them as assumptions.
    if (questionText && subtask) {
      const decided = await ctx.launch({
        prompt: subtaskDecides(resultPromptFor(asked, plan.name)),
        mounts,
        result: asked,
        check: (value) => decidedErrors(completePlan(value as Partial<PlanResult>)),
      });
      result = completePlan(decided.resultValue as Partial<PlanResult>);
    }
    if (questionText && !subtask) {
      return {
        route: { to: 'wait', reason: 'questions are open' },
        summary: `${ctx.opened.startedAt} plan waiting\n${questionText.trimEnd()}`,
        outputs: [
          { artifact: ARTIFACTS.questions, value: questionText },
          { artifact: ARTIFACTS.planResult, value: result },
        ],
      };
    }
    const graph = isSplit(result) ? buildGraph(result) : null;
    const fields = graph
      ? planFields(planItemsFromTasks(graph.tasks))
      : planFields(result.plan, result.name, result.overview);
    const summary = renderSummary(result.summary, fields.items);
    const assumed = questionText && subtask ? assumptions(questionText) : '';
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} plan done\n${fields.items.join('\n')}`,
      outputs: [
        { artifact: ARTIFACTS.requirements, value: withPlan(requirements, fields) },
        { artifact: ARTIFACTS.planResult, value: result },
        ...(limits.maySplit ? splitOutputs(graph) : []),
      ],
      handoff: assumed ? `${summary.trimEnd()}\n${assumed}` : summary,
    };
  }
}

/** What the server checks on a plan answer after its schema: the shape, which `needs` lifted for a subtask only, and the split. */
function planErrors(value: PlanResult, limits: TaskLimits, subtask: boolean): string[] {
  if (subtask && value.needs?.length) {
    return [];
  }
  const shape = value.needs?.length ? planShapeError(value) : null;
  return [...(shape ? [shape] : []), ...(isSplit(value) ? taskErrors(value, unbounded(limits)) : [])];
}

/** A subtask that decided its own questions gives the plan, and no questions or tasks. */
function decidedErrors(value: PlanResult): string[] {
  return value.plan.length > 0 && value.questions.length === 0
    ? []
    : ['plan: give the checklist now, with no questions'];
}
