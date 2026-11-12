import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, Issue, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { CheckoutRepository } from '../../history/checkout.repository';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { settled, withStatuses } from '../../contract/subtask';
import { StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { ERROR_CODES } from '../../contract/error-codes';
import { SandboxService } from '../../sandbox/sandbox.service';
import { branchName, summaryForBranch } from '../branch/branch-name';
import { isChecksReturn, isPipelineReturn, withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
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
import { parseSummary, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { bulletList, items, section } from '../shared/markdown-section';
import { correctedItems, correctedPlan, requireApprovedPlan } from '../plan/plan-record';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { EnvironmentService } from '../../environment/environment.service';
import { withEnvironment } from '../../environment/environment-note';
import { agentWorkplace, projectFor } from '../shared/agent-environment';
import { storedPlan } from '../step';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import { settleRebase, type RebaseDeps } from './implement-rebase';
import { assertUncommitted, featureHeads, worktreeSnapshot, worktreeStatus } from '../../git/worktree-git';
import { staleRepos, unchangedSincePipeline } from '../pipeline/pipeline-report';
import { pipelineRefRepos } from '../pipeline/pipeline-ref-repos';
import { rerunFailed } from './failed-commands';
import { checksStillRed, implementFollowUp } from './implement.prompts';
import { parseImplementation, withReturnNotes } from './implement-record';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepSnapshot } from '../step';
import type { PipelineResult } from '../../core/pipeline-result';
import { SplitImplementStep } from './split-implement.step';

/** The follow-ups a checks return gets in one visit while its failed commands are still red. */
const MAX_CHECK_FOLLOW_UPS = 2;

/** The visit summary of a CI rerun after an unchanged pipeline failure; the agent's own explanation follows it. */
const UNFIXED_RERUN = 'pipeline failure left unchanged, CI rerun: ';
const NO_EXPLANATION = 'the agent gave no explanation';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
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
    ARTIFACTS.requirements,
    ARTIFACTS.pipelineRef,
    ARTIFACTS.ciRerun,
    ARTIFACTS.unfixedIssue,
    ARTIFACTS.rebaseConflict,
    ARTIFACTS.rebaseMergeSkip,
    ARTIFACTS.subtasks,
    ARTIFACTS.contract,
  ];

  constructor(
    kernel: StepKernel,
    sandbox: SandboxService,
    private readonly publisher: RebasedPublisher,
    private readonly checkouts: CheckoutRepository,
    launcher: AgentLauncher,
    private readonly environments: EnvironmentService,
    private readonly split: SplitImplementStep,
  ) {
    super(kernel, sandbox, launcher);
  }

  /**
   * The implement of a run the planner split is the server's passes over its subtasks, not an agent. Once every task
   * is settled, a return from a later step or a rebase conflict is fixed by the agent on the merged feature branch.
   */
  override async execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    const run = await this.runs.findRun(key);
    const tasks = run?.split ? await this.reader.reread(key, ARTIFACTS.subtasks) : null;
    if (!run || !tasks?.length) {
      return super.execute(key, options, snapshot);
    }
    const marker = ((await this.reader.reread(key, ARTIFACTS.rebaseConflict)) ?? '').trim();
    const fixing =
      withStatuses(tasks).every(settled) &&
      (marker.startsWith('pending') || !!(await returnedNotes(this.documents, run.id)));
    return fixing ? super.execute(key, options, snapshot) : this.split.execute(key, options, snapshot);
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
    const plan = requireApprovedPlan(input.requirements);
    const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    if (auto && ctx.opened.run.agentCalls + 1 > env.MAX_AGENT_CALLS) {
      return {
        route: { to: 'block', reason: 'implement does not fit' },
        summary: `${ctx.opened.startedAt} implement does not fit`,
        outputs: [],
      };
    }
    const notes = await returnedNotes(this.documents, ctx.opened.run.id);
    const merged = ctx.opened.run.split
      ? withSubtasks(withContract([], await ctx.reread(ARTIFACTS.contract)), await ctx.reread(ARTIFACTS.subtasks))
      : [];
    const sections = [
      ...withHandoff(withReturnNotes([{ heading: 'Plan', body: plan }], notes), await ctx.reread(ARTIFACTS.handoff)),
      ...merged,
    ];
    const branch = branchName(key, summaryForBranch(input.requirements, key));
    const markerBody = ((await ctx.reread(ARTIFACTS.rebaseConflict)) ?? '').trim();
    const marker = markerBody.split('\n')[0]?.trim() ?? '';
    const storedStderr = markerBody.split('\n').slice(1).join('\n').trim();
    const { runtime } = this.profile(env, ctx.opened.run);
    const fullFor = (target: string): string =>
      skillPrompt('implement', input.requirements, names, sections, mounts, {
        deferExecutionRules: true,
        rules: projectRules(names, mounts, target, false),
      });
    const full = fullFor(runtime);
    const added = await ctx.reread(ARTIFACTS.addedRepos);
    const continued = await resumableChat(root(this.config), key, 'implement', runtime);
    const basePrompt = withAddedRepos(continued?.chatId ? implementFollowUp(plan, notes, merged) : full, added);
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
    const heads = await featureHeads(mounts, branch);
    const place = { run: ctx.opened.run, key, step: this.name, mounts, runtime, samples: ctx.samples };
    const reproject = projectFor(this.environments, place);
    const { prompt, project, allowHosts, manifestHosts, executionRules } = await agentWorkplace(
      this.environments,
      place,
      basePrompt,
    );
    const before = await worktreeSnapshot(mounts);
    let agentResult = await ctx.launch({
      prompt,
      mounts,
      allowHosts,
      manifestHosts,
      project,
      projectFor: reproject,
      briefFor: (other) => withEnvironment(withAddedRepos(fullFor(other), added), executionRules),
      sections: ['implementation'],
      validate: (text) => parseImplementation(text),
      freshPrompt: continued?.chatId ? withEnvironment(withAddedRepos(full, added), executionRules) : undefined,
    });
    await assertUncommitted(mounts, branch, heads);
    let planText = agentResult.responseText;
    let planOutput = agentResult.output ?? '';
    const unchanged = async (): Promise<boolean> =>
      (await unchangedSincePipeline(await ctx.reread(ARTIFACTS.pipelineRef), mounts)) ??
      (await worktreeSnapshot(mounts)) === before;
    const pipelineReturn = isPipelineReturn(notes);
    const { issues: pipelineIssues, unfixed } = pipelineReturn
      ? await pipelineAnswers(this.documents, ctx.opened.run.id)
      : { issues: [], unfixed: new Set<string>() };
    if (pipelineReturn && (await unchanged())) {
      const repeated = pipelineIssues.find((issue) => unfixed.has(issue.id));
      if (repeated) {
        const explanation = await this.previousExplanation(ctx.opened.run.id);
        const line = `${ctx.opened.startedAt} ${repeated.title} failed twice on the same commit and the agent changed nothing: ${explanation}`;
        return {
          route: { to: 'block', code: ERROR_CODES.PIPELINE_UNFIXED, reason: line },
          summary: line,
          outputs: [],
        };
      }
      agentResult = await ctx.launch({
        prompt: withEnvironment(
          `The pipeline failure still stands and the files are unchanged.\n\n${notes?.trim() ?? ''}`,
          executionRules,
        ),
        mounts,
        allowHosts,
        manifestHosts,
        project,
        projectFor: reproject,
      });
      await assertUncommitted(mounts, branch, heads);
      const againOutput = agentResult.output ?? '';
      if (answerHasPlan(agentResult.responseText, againOutput)) {
        planText = agentResult.responseText;
        planOutput = againOutput;
      }
      if (await unchanged()) {
        const stale = await staleRepos(await ctx.reread(ARTIFACTS.pipelineRef), mounts);
        if (stale.length > 0) {
          return {
            route: { to: 'jump', step: 'commit' },
            summary: `${ctx.opened.startedAt} no change needed: the failed pipeline ran on an older commit`,
            outputs: [],
            visit: { documents: [textDocument(ARTIFACTS.ciRerun.kind, `${stale.join('\n')}\n`)] },
          };
        }
        const refRepos = await pipelineRefRepos(await ctx.reread(ARTIFACTS.pipelineRef), mounts);
        return this.rerunResult(
          input.requirements,
          ctx,
          planText,
          planOutput,
          summaryOr(agentResult.responseText, NO_EXPLANATION).trim(),
          pipelineIssues,
          refRepos,
        );
      }
    }
    const sameWorkplace = { mounts, allowHosts, manifestHosts, project, projectFor: reproject };
    let red =
      isChecksReturn(notes) || pipelineReturn
        ? await rerunFailed(this.environments, await ctx.reread(ARTIFACTS.issues), place)
        : [];
    for (let sent = 0; red.length > 0 && sent < MAX_CHECK_FOLLOW_UPS; sent++) {
      agentResult = await ctx.launch({
        ...sameWorkplace,
        prompt: withEnvironment(checksStillRed(red), executionRules),
        sections: ['implementation'],
        validate: (answer) => parseImplementation(answer),
      });
      await assertUncommitted(mounts, branch, heads);
      const againOutput = agentResult.output ?? '';
      if (answerHasPlan(agentResult.responseText, againOutput)) {
        planText = agentResult.responseText;
        planOutput = againOutput;
      }
      red = await this.environments.rerun(place, red);
    }
    const text = agentResult.responseText;
    const body = parseImplementation(text);
    const corrected = correctedPlan(input.requirements, planText, planOutput);
    const reasons = corrected ? `${parseSummary(text).trimEnd()}\n${corrected.handoff}` : parseSummary(text);
    const cause = items(section(text, 'cause') ?? '');
    const summary = cause.length > 0 ? `cause:\n${bulletList(cause)}\n${reasons}` : reasons;
    const status = await worktreeStatus(mounts);
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
      outputs: [{ artifact: ARTIFACTS.implementation, value: body }],
      handoff: summary,
      visit: corrected ? { documents: [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] } : undefined,
    };
  }

  private rebaseDeps(runtime: RuntimeName): RebaseDeps {
    return {
      config: this.config,
      documents: this.documents,
      flows: this.flows,
      checkouts: this.checkouts,
      publisher: this.publisher,
      environments: this.environments,
      step: this.name,
      runtime,
    };
  }

  /** The explanation the agent gave on the CI rerun the last implement visit asked for. */
  private async previousExplanation(runId: number): Promise<string> {
    let last = '';
    let after = 0;
    for (;;) {
      const page = await this.kernel.stepEvents.page(runId, { step: this.name, after });
      for (const event of page.events) {
        if (event.kind === 'attempt.finished' && event.summary.startsWith(UNFIXED_RERUN)) {
          last = event.summary.slice(UNFIXED_RERUN.length).trim();
        }
      }
      if (page.next === null) {
        return last || NO_EXPLANATION;
      }
      after = page.next;
    }
  }

  /** A pipeline failure the retry left unchanged on disk: CI runs the failed jobs again on the same commit. */
  private rerunResult(
    requirements: string,
    ctx: ModelStepContext,
    planText: string,
    planOutput: string,
    explanation: string,
    issues: Issue[],
    repos: string[],
  ): StepResult {
    const corrected = correctedPlan(requirements, planText, planOutput);
    const documents = [
      ...(issues.length > 0
        ? [textDocument(ARTIFACTS.unfixedIssue.kind, issues.map((issue) => issue.id).join('\n'))]
        : []),
      textDocument(ARTIFACTS.ciRerun.kind, `${repos.join('\n')}\n`),
      ...(corrected ? [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] : []),
    ];
    return {
      route: { to: 'jump', step: 'commit' },
      summary: `${ctx.opened.startedAt} ${UNFIXED_RERUN}${explanation}`,
      outputs: [],
      handoff: corrected?.handoff,
      visit: { documents },
    };
  }
}

function answerHasPlan(text: string, output: string): boolean {
  return correctedItems(text, output) !== null;
}
