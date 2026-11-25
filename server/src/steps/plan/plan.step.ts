import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable, Optional } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepCapabilities, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { CONTRACT_KIND, isSubtask } from '../../contract/subtask';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { projectRules } from '../shared/project-rules';
import { AgentDoor } from '../shared/agent-door';
import { appendImpact, assumptions, withHandoff, withImpact } from '../shared/handoff';
import { skillPrompt } from '../shared/skill-prompt';
import { unanswered } from '../shared/answers';
import { storedImpact } from '../shared/research-reads';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { planFields, readPlan, renderSummary, withPlan } from './plan-record';
import { renderQuestions } from '../research/research-record';
import { buildGraph, isSplit, planItemsFromTasks, splitLimits, splitOutputs } from './plan-tasks';
import { withNamedFileLines } from './named-file-lines';
import { completePlan, planFor, type PlanResult } from '../../agent-result/definitions/plan';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { planContinue, planFollowUp } from './plan.prompts';
import { ARTIFACTS } from '../contract/artifacts';
import type { Requirement } from '../../contract/requirement-list';
import { correctCoverage, gapLines, requirementsSection } from '../shared/coverage-correction';
import { coverageOf } from '../shared/requirement-coverage';
import { coverageUnits } from './plan-coverage';
import { planErrors } from '../shared/plan-errors';
import { StarterExchange } from '../shared/starter-exchange';
import { PlanConversation } from '../shared/plan-conversation';
import { PlanChatStore } from '../../history/plan-chat.store';
import { splitFacts } from './task-depth';
import { answerMessages, finished, type MessageDeps } from './plan-messages';

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
    door: AgentDoor,
    @Optional() private readonly planChat?: PlanChatStore,
    @Optional() private readonly conversation?: PlanConversation,
  ) {
    super(kernel, sandbox, door);
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
    const answered = await answerMessages(this.messageDeps(), ctx);
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
      withImpact(withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior), impact),
      [requirements, answers, prior, impact].join('\n'),
      mounts,
    );
    const { runtime, chat, received, goesOn } = await this.sessionFor(ctx.opened.run);
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
    const chosen = goesOn
      ? appendImpact(planFollowUp(answers, resultPromptFor(asked, received)), impact)
      : fullFor(runtime, received, Boolean(chat?.chatId));
    const exchange = new StarterExchange(undefined, this.clock);
    const contract = subtask ? await this.parentDocument(ctx.opened.run, CONTRACT_KIND) : null;
    const check = (value: unknown): string[] => {
      const read = completePlan(value as Partial<PlanResult>);
      return [...planErrors(read, limits, subtask), ...exchange.check(ctx.opened.run, read, contract)];
    };
    const first = await ctx.launch({
      prompt: finish(chosen),
      briefFor: (other) => finish(fullFor(other, null)),
      mounts,
      continuePrompt: planContinue(),
      briefing: { continued: goesOn },
      result: asked,
      check,
    });
    let result = completePlan(first.resultValue as Partial<PlanResult>);
    // A subtask hands back what it asks, decides and leaves out through the one exchange; a run that is not a subtask asks a person.
    const outcome = subtask
      ? await exchange.act(ctx, result, {
          step: this.name,
          route: 'document',
          answered: Boolean(answers.trim() && planned?.question?.trim()),
          mayAsk: true,
          outputs: [{ artifact: ARTIFACTS.planResult, value: result }],
        })
      : null;
    if (outcome?.wait) {
      return outcome.wait;
    }
    if (subtask) await ctx.write(ARTIFACTS.needs, '');
    // The questions the parent answered are closed once the plan goes on.
    if (subtask && questions.trim()) await ctx.write(ARTIFACTS.questions, '');
    const questionText = subtask ? '' : renderQuestions(result.questions);
    if (questionText) {
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
    const assumed = outcome?.assumed.length ? assumptions(renderQuestions(outcome.assumed)) : '';
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

  /** What the messages of a person are answered with; null when the step has no plan chat or conversation. */
  private messageDeps(): MessageDeps | null {
    const { planChat, conversation } = this;
    if (!planChat || !conversation) return null;
    return {
      planChat,
      conversation,
      documents: this.documents,
      visits: this.visits,
      root: root(this.config),
      runtimeOf: (run) => this.profile(this.config.env, run).runtime,
      exchange: new StarterExchange(planChat, this.clock),
      parentOf: async (run) => {
        const parent = typeof run.parentRunId === 'number' ? await this.runs.findById(run.parentRunId) : null;
        return parent ? { run: parent, contract: await this.parentDocument(run, CONTRACT_KIND) } : null;
      },
    };
  }

  /** A stored visit of the plan step itself makes this a re-plan (a planner's turn in the chat is no plan visit); the session records the last definition sent into the shared chat. */
  private async sessionFor(run: RunEntity) {
    const { runtime } = this.profile(this.config.env, run);
    const chat = await resumableChat(root(this.config), run.key, 'plan', runtime);
    const planVisit = await this.visits.hasStepVisit(run.id, 'plan');
    const continued = planVisit ? chat : null;
    const received = chat?.chatId ? (chat.resultName ?? null) : null;
    return { runtime, chat, received, goesOn: Boolean(continued?.chatId) };
  }
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
