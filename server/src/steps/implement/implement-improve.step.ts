import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { branchName, summaryForBranch } from '../branch/branch-name';
import { withEnvironment } from '../../environment/environment-note';
import { withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { returnedNotes, textDocument, withHandoff } from '../shared/handoff';
import { currentPlan } from '../shared/current-plan';
import { projectRules } from '../shared/project-rules';
import { skillPrompt } from '../shared/skill-prompt';
import { correctedPlan, renderSummary, requireApprovedPlan } from '../plan/plan-record';
import {
  implementationImprove,
  type ImplementationImproveResult,
} from '../../agent-result/definitions/implementation-improve';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { EnvironmentService } from '../../environment/environment.service';
import { agentWorkplace, projectFor } from '../shared/agent-environment';
import { assertUncommitted, featureHeads, worktreeStatus } from '../../git/worktree-git';
import { implementImproveFollowUp } from './implement.prompts';
import { firstPass, renderCause, renderImplementation, withReturnNotes } from './implement-record';
import { lastReceived } from './implement-chat';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  planResult: lateInput(ARTIFACTS.planResult),
  planImproveResult: lateInput(ARTIFACTS.planImproveResult),
  implementationResult: lateInput(ARTIFACTS.implementationResult),
  implementationImproveResult: lateInput(ARTIFACTS.implementationImproveResult),
  implementation: { ...lateInput(ARTIFACTS.implementation), need: 'start' },
  returns: lateInput(ARTIFACTS.issues),
  repos: lateInput(ARTIFACTS.repos),
  addedRepos: lateInput(ARTIFACTS.addedRepos),
  instructions: instructionsInput('implement-improve'),
} as const satisfies InputSpec;

@Injectable()
export class ImplementImproveStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'implement-improve';
  readonly outputs = [
    ARTIFACTS.implementation,
    ARTIFACTS.implementationResult,
    ARTIFACTS.implementationImproveResult,
    ARTIFACTS.requirements,
  ];

  constructor(
    kernel: StepKernel,
    sandbox: SandboxService,
    launcher: AgentLauncher,
    private readonly environments: EnvironmentService,
  ) {
    super(kernel, sandbox, launcher);
  }

  protected profile(env: SwarmloopEnv, run?: RunEntity | null): AgentProfile {
    return {
      ...agentFor(env, run ?? null, 'implement-improve'),
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
    const pass = await firstPass(ctx);
    if (!pass?.implementation.length) {
      throw new SwarmloopError('implementation is missing');
    }
    const notes = renderImplementation(pass.implementation);
    const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    if (auto && ctx.opened.run.agentCalls + 1 > env.MAX_AGENT_CALLS) {
      return {
        route: { to: 'block', reason: 'implement-improve does not fit' },
        summary: `${ctx.opened.startedAt} implement-improve does not fit`,
        outputs: [],
      };
    }
    const returned = await returnedNotes(this.documents, ctx.opened.run.id);
    const sections = withHandoff(
      withReturnNotes(
        [
          { heading: 'Plan', body: plan },
          { heading: 'Implementation', body: notes },
        ],
        returned,
      ),
      await ctx.reread(ARTIFACTS.handoff),
    );
    const branch = branchName(key, summaryForBranch(input.requirements, key));
    const heads = await featureHeads(mounts, branch);
    const { runtime } = this.profile(this.config.env, ctx.opened.run);
    const continued = await resumableChat(root(this.config), key, 'implement-improve', runtime);
    const received = continued?.chatId ? await lastReceived(this.documents, key) : null;
    const fullFor = (target: string): string =>
      [
        skillPrompt('implement-improve', input.requirements, names, sections, mounts, {
          deferExecutionRules: true,
          rules: projectRules(names, mounts, target, false),
        }),
        resultPromptFor(implementationImprove, null),
      ].join('\n\n');
    const full = fullFor(runtime);
    const chosen = received ? implementImproveFollowUp(returned, received) : full;
    const added = await ctx.reread(ARTIFACTS.addedRepos);
    const place = { run: ctx.opened.run, key, step: this.name, mounts, runtime, samples: ctx.samples };
    const reproject = projectFor(this.environments, place);
    const { prompt, project, allowHosts, manifestHosts, executionRules } = await agentWorkplace(
      this.environments,
      place,
      withAddedRepos(chosen, added),
    );
    const agentResult = await ctx.launch({
      prompt,
      mounts,
      allowHosts,
      manifestHosts,
      project,
      projectFor: reproject,
      briefFor: (other) => withEnvironment(withAddedRepos(fullFor(other), added), executionRules),
      result: implementationImprove,
      freshPrompt: continued?.chatId ? withEnvironment(withAddedRepos(full, added), executionRules) : undefined,
    });
    await assertUncommitted(mounts, branch, heads);
    const value = agentResult.resultValue as ImplementationImproveResult;
    // An empty implementation means this pass left the first pass as it was.
    const items = value.implementation?.length ? value.implementation : pass.implementation;
    const body = renderImplementation(items);
    // The checklist in force goes with both results, so `currentPlan` keeps a correction an earlier result made.
    const inForce = value.plan?.length ? value.plan : current?.items;
    const corrected = correctedPlan(input.requirements, value.plan, current?.items ?? []);
    const reasons = renderSummary(value.summary, ['checked the first pass']);
    const why = corrected ? `${reasons.trimEnd()}\n${corrected.handoff}` : reasons;
    const handoffBody = value.cause?.length ? `${renderCause(value.cause)}${why}` : why;
    const status = await worktreeStatus(mounts);
    const line = `${ctx.opened.startedAt} implement-improve done\n${body.trimEnd()}\n${status}`;
    return {
      route: { to: 'next' },
      summary: line,
      outputs: [
        { artifact: ARTIFACTS.implementation, value: body },
        {
          artifact: ARTIFACTS.implementationResult,
          value: { implementation: items, summary: value.summary, plan: inForce },
        },
        { artifact: ARTIFACTS.implementationImproveResult, value: { ...value, plan: inForce } },
      ],
      handoff: handoffBody,
      visit: corrected ? { documents: [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] } : undefined,
    };
  }
}
