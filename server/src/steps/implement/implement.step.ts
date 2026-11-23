import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable, Optional } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { CONTRACT_KIND, isSubtask } from '../../contract/subtask';
import { StepOptions } from '../../core/pipeline-result';
import { REASON } from '../../contract/run-state';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { RunNames } from '../shared/run-names';
import { RunAuthor } from '../shared/run-author';
import { GitRulesWriter } from '../shared/git-rules-writer';
import { isChecksReturn, isPipelineReturn, withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentDoor } from '../shared/agent-door';
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
import { openWorkplace } from './implement-workplace';
import { storedPlan } from '../step';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import { settleRebase } from './implement-rebase';
import type { RebaseDeps } from './rebase-resolved';
import { assertUncommitted, worktreeStatus } from '../../git/worktree-git';
import { unchangedSincePipeline } from '../pipeline/pipeline-report';
import { rerunFailed } from './failed-commands';
import { checksStillRed, implementAsk, implementFollowUp, planAmendment, resultTextFor } from './implement.prompts';
import { amendmentOf } from '../shared/amendment';
import { implementErrors, implementExchange, withAssumptions } from './implement-asks';
import { StarterExchange } from '../shared/starter-exchange';
import { answerFollowUp, answerSection, mayAsk, readAnswer, takeAnswer } from './implement-question';
import { PlanChatStore } from '../../history/plan-chat.store';
import { gitRulesNoteOutputs, renderCause, renderImplementation, withReturnNotes } from './implement-record';
import { retryUnchangedPipeline } from './implement-pipeline-return';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepSnapshot } from '../step';
import type { PipelineResult } from '../../core/pipeline-result';
import { SplitImplementStep } from './split-implement.step';
import { implementRunner } from './split-or-fix';

/** The follow-ups a checks return gets in one visit while its failed commands are still red. */
const MAX_CHECK_FOLLOW_UPS = 2;

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  planResult: lateInput(ARTIFACTS.planResult),
  planImproveResult: lateInput(ARTIFACTS.planImproveResult),
  // Shown as an input card of the window; the prompt does not carry the coverage.
  requirementCoverage: { artifact: ARTIFACTS.requirementCoverage, need: 'optional' },
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
    ARTIFACTS.questionParts,
    ARTIFACTS.needs,
    ARTIFACTS.gitRulesNote,
    ARTIFACTS.starterTaken,
    ARTIFACTS.mergeLook,
  ];

  constructor(
    kernel: StepKernel,
    sandbox: SandboxService,
    private readonly publisher: RebasedPublisher,
    door: AgentDoor,
    private readonly environments: EnvironmentService,
    private readonly split: SplitImplementStep,
    private readonly runNames: RunNames,
    private readonly runAuthor: RunAuthor,
    private readonly gitRules: GitRulesWriter,
    @Optional() private readonly planChat?: PlanChatStore,
  ) {
    super(kernel, sandbox, door);
  }

  /**
   * The implement of a run the planner split is the server's passes over its subtasks, not an agent. Once every task
   * is settled, a defect return from a later step or a rebase conflict is fixed by the agent on the merged feature
   * branch. A final review that marks requirements missing is the split pass's: it becomes a task of the list.
   */
  override async execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    const run = await this.runs.findRun(key);
    return (await implementRunner(this.reader, this.documents, run)) === 'agent'
      ? super.execute(key, options, snapshot)
      : this.split.execute(key, options, snapshot);
  }

  /** The split pass launches no agent, so it is not an agent start. */
  async launchesAgent(key: string): Promise<boolean> {
    return (await implementRunner(this.reader, this.documents, await this.runs.findRun(key))) === 'agent';
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
        route: { to: 'block', reason: 'implement does not fit', code: REASON.didNotFit },
        summary: `${ctx.opened.startedAt} implement does not fit`,
        outputs: [],
      };
    }
    const notes = await returnedNotes(this.documents, ctx.opened.run.id);
    const merged = [
      ...(ctx.opened.run.split
        ? withSubtasks(withContract([], await ctx.reread(ARTIFACTS.contract)), await ctx.reread(ARTIFACTS.subtasks))
        : []),
      ...planAmendment(await amendmentOf(this.documents, this.visits, ctx.opened.run)),
    ];
    const answer = await readAnswer(this.planChat, key, this.name);
    const sections = [
      ...withHandoff(withReturnNotes([{ heading: 'Plan', body: plan }], notes), await ctx.reread(ARTIFACTS.handoff)),
      ...merged,
      ...(answer ? [answerSection(answer)] : []),
    ];
    const branch = await this.runNames.branchOf(ctx.opened.run, names);
    const markerBody = ((await ctx.reread(ARTIFACTS.rebaseConflict)) ?? '').trim();
    const marker = markerBody.split('\n')[0]?.trim() ?? '';
    const storedStderr = markerBody.split('\n').slice(1).join('\n').trim();
    const { runtime } = this.profile(env, ctx.opened.run);
    const subtask = isSubtask(ctx.opened.run);
    const ask = implementAsk(notes, subtask);
    const fullFor = (target: string): string =>
      [
        skillPrompt('implement', input.requirements, names, sections, mounts, {
          deferExecutionRules: true,
          rules: projectRules(names, mounts, target, false),
        }),
        ...ask.lines,
        resultPromptFor(ask.definition, null),
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
    const followUp = answer
      ? answerFollowUp(answer, resultTextFor(ask, received))
      : implementFollowUp(plan, notes, merged, received, subtask);
    const basePrompt = withAddedRepos(continued?.chatId ? followUp : full, added);
    const {
      heads,
      place,
      reproject,
      prompt,
      project,
      allowHosts,
      manifestHosts,
      executionRules,
      snapshot,
      before,
      sameWorkplace,
    } = await openWorkplace(this.environments, ctx, this.name, { mounts, runtime, branch, basePrompt });
    const mayQuestion =
      !answer && (await mayAsk(ctx.opened.run, this.planChat, { root: root(this.config), env: this.config.env }));
    const exchange = new StarterExchange(this.planChat, this.clock);
    const contract = subtask ? await this.parentDocument(ctx.opened.run, CONTRACT_KIND) : null;
    const asked = (value: unknown): string[] =>
      implementErrors(ctx.opened.run, value as ImplementationResult, mayQuestion, exchange, contract);
    const first = await ctx.launch({
      prompt,
      mounts,
      allowHosts,
      manifestHosts,
      project,
      projectFor: reproject,
      briefFor: (other) => withEnvironment(withAddedRepos(fullFor(other), added), executionRules),
      result: ask.definition,
      check: asked,
      briefing: { continued: continued !== null },
      freshPrompt: continued?.chatId ? withEnvironment(withAddedRepos(full, added), executionRules) : undefined,
    });
    await assertUncommitted(mounts, branch, heads);
    await takeAnswer(this.planChat, key, answer);
    let value = first.resultValue as ImplementationResult;
    const asks = await implementExchange(exchange, ctx, { answered: Boolean(answer), mayAsk: mayQuestion }, value);
    if (asks.wait) {
      return asks.wait;
    }
    if (isSubtask(ctx.opened.run)) await ctx.write(ARTIFACTS.needs, '');
    // The newest checklist an answer of this visit corrected.
    let corrected = value.plan?.length ? value.plan : undefined;
    const unchanged = async (): Promise<boolean> =>
      (await unchangedSincePipeline(await ctx.reread(ARTIFACTS.pipelineRef), mounts)) ??
      (await snapshot(mounts)) === before;
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
    const note = await this.gitRules.write(mounts, value.gitRules);
    const summary = withAssumptions(value.cause?.length ? `${renderCause(value.cause)}${why}` : why, asks.assumed);
    const status = await worktreeStatus(mounts);
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
      outputs: [
        { artifact: ARTIFACTS.implementation, value: body },
        // The checklist in force goes with the result, so a later result without a correction keeps it for `currentPlan`.
        { artifact: ARTIFACTS.implementationResult, value: { ...value, plan: corrected ?? current?.items } },
        ...gitRulesNoteOutputs(note),
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
      publisher: this.publisher,
      names: this.runNames,
      author: this.runAuthor,
      environments: this.environments,
      step: this.name,
      runtime,
    };
  }
}
