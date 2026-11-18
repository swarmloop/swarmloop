import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable, Optional } from '@nestjs/common';
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
import { implementedWithoutTasks } from '../shared/amendment';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { planFields, readPlan, renderSummary, withPlan } from './plan-record';
import { renderQuestions } from '../research/research-record';
import {
  addTasksCheck,
  buildGraph,
  isSplit,
  planItemsFromTasks,
  splitLimits,
  splitOutputs,
  startedTasks,
  type TaskLimits,
} from './plan-tasks';
import { withNamedFileLines } from './named-file-lines';
import { completePlan, plan, planFor, type PlanResult } from '../../agent-result/definitions/plan';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { needsWait } from '../shared/needs';
import {
  planChatAddsTasks,
  planChatAmends,
  planChatFollowUp,
  planContinue,
  planFollowUp,
  subtaskDecides,
} from './plan.prompts';
import { ARTIFACTS } from '../contract/artifacts';
import type { Requirement } from '../../contract/requirement-list';
import { correctCoverage, gapLines, requirementsSection } from '../shared/coverage-correction';
import { coverageOf } from '../shared/requirement-coverage';
import { coverageUnits } from './plan-coverage';
import { decidedErrors, planErrors } from '../shared/plan-errors';
import { PlanConversation } from '../shared/plan-conversation';
import { storedGraph } from '../shared/stored-graph';
import { PlanChatStore } from '../../history/plan-chat.store';
import { planReplyFor, type PlanReplyResult } from '../../agent-result/definitions/plan-reply';
import { splitFacts } from './task-depth';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  questions: lateInput(ARTIFACTS.questions),
  answers: lateInput(ARTIFACTS.answers),
  impact: lateInput(ARTIFACTS.impact),
  researchResult: lateInput(ARTIFACTS.researchResult),
  planResult: lateInput(ARTIFACTS.planResult),
  requirementList: lateInput(ARTIFACTS.requirementList),
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
    ARTIFACTS.requirementCoverage,
    ARTIFACTS.requirementList,
  ];

  constructor(
    kernel: StepKernel,
    sandbox: SandboxService,
    launcher: AgentLauncher,
    @Optional() private readonly planChat?: PlanChatStore,
    @Optional() private readonly conversation?: PlanConversation,
  ) {
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
    const answered = await this.answerMessages(ctx);
    if (answered) return answered;
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
    // A stored plan visit makes this a re-plan; the session records the last definition sent into the shared chat.
    const { runtime } = this.profile(this.config.env, ctx.opened.run);
    const chat = await resumableChat(root(this.config), key, 'plan', runtime);
    const planVisit = await this.visits.hasAgentVisit(ctx.opened.run.id, 'plan');
    const continued = planVisit ? chat : null;
    const received = chat?.chatId ? (chat.resultName ?? null) : null;
    const limits = splitLimits(ctx.opened.run, this.config.env.SPLIT_MAX_TASKS);
    const added = await ctx.reread(ARTIFACTS.addedRepos);
    const list = await ctx.reread(ARTIFACTS.requirementList);
    const subtask = isSubtask(ctx.opened.run);
    const asked = planFor({ split: limits.maySplit, subtask });
    const fullFor = (target: string, chatReceived: string | null, resumed = false): string =>
      [
        skillPrompt('plan', input.requirements, names, listed(sections, list, resumed && !subtask), mounts, {
          split: limits.maySplit,
          rules: projectRules(names, mounts, target, resumed),
        }),
        resultPromptFor(asked, chatReceived),
      ].join('\n\n');
    const finish = (prompt: string): string => finished(prompt, added);
    const chosen = continued?.chatId
      ? appendImpact(planFollowUp(answers, resultPromptFor(asked, received)), impact)
      : fullFor(runtime, received, Boolean(chat?.chatId));
    const check = (value: unknown): string[] => planErrors(completePlan(value as Partial<PlanResult>), limits, subtask);
    const first = await ctx.launch({
      prompt: finish(chosen),
      briefFor: (other) => finish(fullFor(other, null)),
      mounts,
      continuePrompt: planContinue(),
      result: asked,
      check,
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
    const coverage = list
      ? await correctCoverage(
          ctx,
          {
            mounts,
            result: asked,
            check,
            continuePrompt: planContinue(),
            read: (value) => completePlan(value as Partial<PlanResult>),
            listOf: () => list,
            unitsOf: coverageUnits,
          },
          result,
        )
      : null;
    if (coverage) result = coverage.value;
    const gaps = gapLines(coverage?.problems ?? []);
    const graph = isSplit(result) ? buildGraph(result) : null;
    const fields = graph
      ? planFields(planItemsFromTasks(graph.tasks))
      : planFields(result.plan, result.name, result.overview);
    const summary = renderSummary(result.summary, fields.items);
    const assumed = questionText && subtask ? assumptions(questionText) : '';
    const notes = [...gaps, ...(assumed ? [assumed] : [])];
    return {
      route: { to: 'next' },
      summary: [`${ctx.opened.startedAt} plan done`, ...fields.items, ...gaps].join('\n'),
      outputs: [
        { artifact: ARTIFACTS.requirements, value: withPlan(requirements, fields) },
        { artifact: ARTIFACTS.planResult, value: result },
        ...(limits.maySplit ? splitOutputs(graph) : []),
        ...(coverage
          ? [{ artifact: ARTIFACTS.requirementCoverage, value: coverageOf(coverage.list, coverage.units) }]
          : []),
      ],
      handoff: notes.length > 0 ? [summary.trimEnd(), ...notes].join('\n') : summary,
      ...(limits.maySplit && graph ? { facts: splitFacts(graph.tasks) } : {}),
    };
  }

  /** What a message is asked and checked with: tasks only for a split run whose tasks started, an amendment for a run that implemented without splitting. */
  private async replyRoute(ctx: ModelStepContext, limits: TaskLimits, subtask: boolean) {
    const { run } = ctx.opened;
    const graph = await storedGraph(ctx);
    const adding = limits.maySplit && !subtask && startedTasks(graph.tasks).length > 0;
    const amending = await implementedWithoutTasks(this.documents, this.visits, run);
    return {
      asked: planReplyFor({ split: limits.maySplit, subtask, ...(adding ? { addTasksOnly: true } : {}) }),
      followUp: adding ? planChatAddsTasks : amending ? planChatAmends : planChatFollowUp,
      check: adding
        ? addTasksCheck(graph, limits)
        : (value: unknown) => planErrors(completePlan(value as Partial<PlanResult>), limits, subtask),
    };
  }

  /**
   * The messages a person sent are answered in the plan's own chat, with the reply the planner gives. Null when none is
   * waiting, or when there is no plan or no plan chat yet: the message then waits for the first plan, and plan-improve sends the run back.
   */
  private async answerMessages(ctx: ModelStepContext): Promise<StepResult | null> {
    const { run } = ctx.opened;
    if (!this.planChat || !this.conversation) return null;
    const pending = await this.planChat.pending(run.key);
    const { runtime } = this.profile(this.config.env, run);
    const chat = pending.length > 0 ? await resumableChat(root(this.config), run.key, 'plan', runtime) : null;
    // The chat can exist before the first plan (research shares it): a message waits until there is a plan to change.
    if (!chat?.chatId || !readPlan(await ctx.reread(ARTIFACTS.requirements))) return null;
    const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
    const mounts = mountsForStep(root(this.config), run.key, names, run.targetPath);
    const limits = await this.conversation.limits(run);
    const subtask = isSubtask(run);
    const { asked, followUp, check } = await this.replyRoute(ctx, limits, subtask);
    const received = chat.resultName ?? null;
    const impact = storedImpact(await ctx.reread(ARTIFACTS.researchResult), await ctx.reread(ARTIFACTS.impact));
    const reason = pending.map((message) => message.text.trim()).join('\n\n');
    // The reply streams to the person while the planner writes it, until its stored entry takes its place.
    const { conversation } = this;
    const applied = await conversation.whileReplying(run.key, async () => {
      const launched = await ctx.launch({
        prompt: finished(
          appendImpact(followUp(pending, resultPromptFor(asked, received)), impact),
          await ctx.reread(ARTIFACTS.addedRepos),
        ),
        mounts,
        result: asked,
        check,
      });
      return conversation.applyReply(ctx, launched.resultValue as PlanReplyResult, reason);
    });
    await this.planChat.markTaken(
      run.key,
      pending.map((message) => message.key),
    );
    // A reply that leaves a plan plan-improve already approved as it was has nothing new to check: the run goes on past it.
    const checked = readPlan(await ctx.reread(ARTIFACTS.requirements))?.decision === 'approve';
    return {
      route: applied.outputs.length === 0 && checked ? { to: 'jump', step: 'branch' } : { to: 'next' },
      summary: `${ctx.opened.startedAt} plan answered`,
      outputs: applied.outputs,
      ...(applied.handoff ? { handoff: applied.handoff } : {}),
    };
  }
}

function finished(prompt: string, added: string | null): string {
  return `${withAddedRepos(prompt, added)}\n\n${PLAN_EXECUTION_RULE}`;
}

/**
 * The sections with the requirements list, unless the prompt resumes a chat that already holds it. Research answers the
 * list of a run in the chat the plan resumes; a subtask's list is built by the server, so that chat never held it.
 */
function listed(
  sections: { heading: string; body: string }[],
  list: Requirement[] | null | undefined,
  resumed: boolean,
): { heading: string; body: string }[] {
  return list && !resumed ? [...sections, requirementsSection(list)] : sections;
}
