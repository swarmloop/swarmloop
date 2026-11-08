import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { readSession } from '../../agent/agent-runner';
import { sessionFileName } from '../../history/session-group';
import { StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { branchName, summaryForBranch } from '../branch/branch-name';
import { withAddedRepos } from '../follow-up';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { returnedNotes, textDocument, withHandoff } from '../shared/handoff';
import { plainSummary, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { correctedPlan, requireApprovedPlan } from '../plan/plan-record';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { EnvironmentService } from '../../environment/environment.service';
import { agentWorkplace } from '../shared/agent-environment';
import { assertUncommitted, featureHeads, worktreeStatus } from '../../git/worktree-git';
import { implementImproveFollowUp } from './implement.prompts';
import { RequiredCheckRepeated } from '../../environment/project-environments';
import {
  checkRepeatedBlock,
  checksLine,
  implementFacts,
  reviewedImplementation,
  withReturnNotes,
} from './implement-record';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
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
  readonly outputs = [ARTIFACTS.implementation, ARTIFACTS.requirements];

  constructor(
    kernel: StepKernel,
    sandbox: SandboxService,
    launcher: AgentLauncher,
    private readonly environments: EnvironmentService,
  ) {
    super(kernel, sandbox, launcher);
  }

  protected profile(env: SwarmloopEnv): AgentProfile {
    return {
      runtime: env.RUNTIME,
      model: env.MODEL_IMPLEMENT,
      mode: 'agent',
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
    const notes = await ctx.reread(ARTIFACTS.implementation);
    if (!notes?.trim()) {
      throw new SwarmloopError('implementation is missing');
    }
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
    const continued = await readSession(
      join(root(this.config), 'data', sessionFileName(key, 'implement-improve')),
      ctx.opened.run.runtime,
    );
    const full = skillPrompt('implement-improve', input.requirements, names, sections, mounts, {
      deferExecutionRules: true,
    });
    const chosen = continued?.chatId ? implementImproveFollowUp(returned) : full;
    const { prompt, project, allowHosts } = await agentWorkplace(
      this.environments,
      { run: ctx.opened.run, key, step: this.name, mounts },
      withAddedRepos(chosen, await ctx.reread(ARTIFACTS.addedRepos)),
    );
    const agentResult = await ctx.launch({ prompt, mounts, allowHosts, project, sections: ['implementation'] });
    const text = agentResult.responseText;
    await assertUncommitted(mounts, branch, heads);
    const wrote = reviewedImplementation(text);
    let checks: string;
    try {
      checks = checksLine(
        await ctx.activity(
          'Server checks',
          () => this.environments.check({ run: ctx.opened.run, key, step: this.name, mounts }),
          checksLine,
        ),
      );
    } catch (error) {
      if (error instanceof RequiredCheckRepeated) {
        return checkRepeatedBlock(ctx.opened.startedAt, this.name, error);
      }
      throw error;
    }
    await assertUncommitted(mounts, branch, heads);
    const body = wrote.trim() ? wrote : notes;
    const corrected = correctedPlan(input.requirements, text, agentResult.output ?? '');
    const summary = summaryOr(text, plainSummary(text) || '- checked the first pass\n');
    const handoffBody = corrected ? `${summary.trimEnd()}\n${corrected.handoff}` : summary;
    const status = await worktreeStatus(mounts);
    const line = `${ctx.opened.startedAt} implement-improve done\n${body.trimEnd()}\n${status}`;
    return {
      route: { to: 'next' },
      summary: line,
      outputs: [{ artifact: ARTIFACTS.implementation, value: body }],
      handoff: handoffBody,
      facts: implementFacts(checks),
      visit: corrected ? { documents: [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] } : undefined,
    };
  }
}
