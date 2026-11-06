import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { CheckoutRepository } from '../../history/checkout.repository';
import { root } from '../../history/run-paths';
import { readSession } from '../../agent/agent-runner';
import { sessionFileName } from '../../history/session-group';
import { StepOptions, nextStep } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { branchName, commitMessage, summaryForBranch } from '../branch/branch-name';
import { CommitStep } from '../commit/commit.step';
import { isPipelineReturn, withAddedRepos } from '../follow-up';
import { git, gitDetail } from '../../git/git';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { composedReturn, textDocument, withHandoff } from '../shared/handoff';
import { parseSummary, skillPrompt } from '../shared/skill-prompt';
import { correctedItems, correctedPlan, requireApprovedPlan } from '../plan/plan-record';
import type { SandboxMount } from '../../core/sandbox-mount';
import { mountsForStep, repoNames, worktreePath } from '../../git/repo-names';
import { EnvironmentService } from '../../environment/environment.service';
import { RequiredCheckFailed } from '../../environment/project-environments';
import { withEnvironment } from '../../environment/environment-note';
import { agentWorkplace } from '../shared/agent-environment';
import { storedPlan } from '../step';
import { RebaseStop, parkedConflict, rebaseFeatureRepos, unmergedPaths } from '../../git/rebase';
import { assertUncommitted, featureHeads, worktreeSnapshot, worktreeStatus } from '../../git/worktree-git';
import { staleRepos } from '../pipeline/pipeline-report';
import { implementFollowUp, rebaseConflictPrompt } from './implement.prompts';
import { parseImplementation, withReturnNotes } from './implement-record';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
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
  readonly outputs = [ARTIFACTS.implementation, ARTIFACTS.requirements];

  constructor(
    kernel: StepKernel,
    sandbox: SandboxService,
    private readonly commit: CommitStep,
    private readonly checkouts: CheckoutRepository,
    launcher: AgentLauncher,
    private readonly environments: EnvironmentService,
  ) {
    super(kernel, sandbox, launcher);
  }

  override missingInput(key: string): Promise<string | null> {
    return storedPlan(this.documents, key);
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
    const names = repoNames((await this.documents.latestBody(key, ARTIFACTS.repos.kind)) ?? '');
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    if (auto && ctx.opened.run.agentCalls + 1 > env.MAX_AGENT_CALLS) {
      return {
        route: { to: 'block', reason: 'implement does not fit' },
        summary: `${ctx.opened.startedAt} implement does not fit`,
        outputs: [],
      };
    }
    const notes = composedReturn(await this.documents.listDocuments(ctx.opened.run.id));
    const sections = withHandoff(
      withReturnNotes([{ heading: 'Plan', body: plan }], notes),
      await this.documents.latestBody(key, ARTIFACTS.handoff.kind),
    );
    const branch = branchName(key, summaryForBranch(input.requirements, key));
    const markerBody = ((await this.documents.latestBody(key, ARTIFACTS.rebaseConflict.kind)) ?? '').trim();
    const marker = markerBody.split('\n')[0]?.trim() ?? '';
    const storedStderr = markerBody.split('\n').slice(1).join('\n').trim();
    const full = skillPrompt('implement', input.requirements, names, sections, mounts, { deferExecutionRules: true });
    const added = await this.documents.latestBody(key, ARTIFACTS.addedRepos.kind);
    const continued = await readSession(
      join(root(this.config), 'data', sessionFileName(key, 'implement')),
      ctx.opened.run.runtime,
    );
    const basePrompt = withAddedRepos(continued?.chatId ? implementFollowUp(plan, notes) : full, added);
    const settled = await this.settleRebase(input.requirements, ctx, marker, names, branch, storedStderr);
    if (settled) {
      return settled;
    }
    const heads = await featureHeads(mounts, branch);
    const { prompt, project, allowHosts, executionRules } = await agentWorkplace(
      this.environments,
      { run: ctx.opened.run, key, step: this.name, mounts },
      basePrompt,
    );
    const before = await worktreeSnapshot(mounts);
    let agentResult = await ctx.launch({ prompt, mounts, allowHosts, project });
    await assertUncommitted(mounts, branch, heads);
    let planText = agentResult.responseText;
    let planOutput = agentResult.output ?? '';
    if (isPipelineReturn(notes) && (await worktreeSnapshot(mounts)) === before) {
      agentResult = await ctx.launch({
        prompt: withEnvironment(
          `The pipeline failure still stands and the files are unchanged.\n\n${notes?.trim() ?? ''}`,
          executionRules,
        ),
        mounts,
        allowHosts,
        project,
      });
      await assertUncommitted(mounts, branch, heads);
      const againOutput = agentResult.output ?? '';
      if (answerHasPlan(agentResult.responseText, againOutput)) {
        planText = agentResult.responseText;
        planOutput = againOutput;
      }
      if ((await worktreeSnapshot(mounts)) === before) {
        const stale = await staleRepos(await this.documents.latestBody(key, ARTIFACTS.pipelineRef.kind), mounts);
        if (stale.length > 0) {
          return {
            route: { to: 'jump', step: 'commit' },
            summary: `${ctx.opened.startedAt} no change needed: the failed pipeline ran on an older commit`,
            outputs: [],
            visit: { documents: [textDocument(ARTIFACTS.ciRerun.kind, `${stale.join('\n')}\n`)] },
          };
        }
        return this.unfixedFailure(input.requirements, ctx, planText, planOutput, 'pipeline failure left unfixed');
      }
    }
    const text = agentResult.responseText;
    const body = parseImplementation(text);
    await this.gate(ctx, key, mounts);
    await assertUncommitted(mounts, branch, heads);
    const corrected = correctedPlan(input.requirements, planText, planOutput);
    const summary = corrected ? `${parseSummary(text).trimEnd()}\n${corrected.handoff}` : parseSummary(text);
    const status = await worktreeStatus(mounts);
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
      outputs: [{ artifact: ARTIFACTS.implementation, value: body }],
      handoff: summary,
      visit: corrected ? { documents: [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] } : undefined,
    };
  }

  /** implement-improve follows in the same pass and runs the one server gate over both passes' changes. */
  private async gate(ctx: ModelStepContext, key: string, mounts: SandboxMount[]): Promise<void> {
    if (nextStep(this.name, await this.flows.activePhases(ctx.opened.run.id)) !== 'implement-improve') {
      await this.environments.check({ run: ctx.opened.run, key, step: this.name, mounts });
    }
  }

  /** A pipeline failure that the retry left unchanged on disk: stop with the corrected checklist, if one came back. */
  private unfixedFailure(
    requirements: string,
    ctx: ModelStepContext,
    planText: string,
    planOutput: string,
    text: string,
  ): StepResult {
    const corrected = correctedPlan(requirements, planText, planOutput);
    const line = `${ctx.opened.startedAt} ${text}`;
    return {
      route: { to: 'fail', error: { code: this.name, message: line } },
      summary: line,
      outputs: [],
      handoff: corrected?.handoff,
      visit: corrected ? { documents: [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] } : undefined,
    };
  }

  /** Finish an open rebase in the server. A stored checklist then goes to code review; an unfinished one returns to the checklist prompt. */
  private async settleRebase(
    requirements: string,
    ctx: ModelStepContext,
    marker: string,
    names: string[],
    branch: string,
    storedStderr: string,
  ): Promise<StepResult | null> {
    const { key } = ctx.opened.run;
    if (marker !== 'pending' && marker !== 'pending-implement') {
      return null;
    }
    const bases = new Map<string, string>();
    const input = {
      root: root(this.config),
      key,
      repos: names,
      branch,
      prompt: ctx.opened.run.prompt,
      denied: await this.checkouts.listDenyPaths(),
      message: commitMessage(key, summaryForBranch(requirements, key)),
      hosts: { ...this.config.env, clock: this.clock },
      onBase: (repo: string, sha: string) => {
        bases.set(repo, sha);
      },
    };
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    let outcome: RebaseStop | null = null;
    for (const repo of names) {
      const parked = await parkedConflict(worktreePath(root(this.config), key, repo), repo, ctx.opened.run.prompt);
      if (parked) {
        outcome = parked;
        break;
      }
    }
    if (!outcome) {
      outcome = await rebaseFeatureRepos(input);
    }
    const seen = new Set<string>();
    while (outcome.kind === 'conflict') {
      if (!outcome.stderr.trim() && storedStderr) {
        outcome = { ...outcome, stderr: storedStderr };
      }
      const id = `${outcome.repo}\0${outcome.files.slice().sort().join('\0')}`;
      if (seen.has(id)) {
        return this.failConflict(ctx, outcome);
      }
      seen.add(id);
      const workplace = await agentWorkplace(
        this.environments,
        { run: ctx.opened.run, key, step: this.name, mounts },
        `${rebaseConflictPrompt({
          repo: outcome.repo,
          files: outcome.files,
          requirements,
          base: outcome.base,
          commit: outcome.commit,
        })}\n`,
      );
      await ctx.launch({
        ...workplace,
        mounts,
        resume: false,
      });
      const cwd = worktreePath(root(this.config), key, outcome.repo);
      const still = await unmergedPaths(cwd);
      if (still.length > 0) {
        try {
          await git(['-C', cwd, 'add', '--', ...still]);
        } catch (error) {
          throw new SwarmloopError(`${outcome.repo} rebase failed: ${gitDetail(error)}`);
        }
      }
      outcome = await rebaseFeatureRepos(input);
    }
    await this.environments.refreshAfterRebase(ctx.opened.run, mounts, bases);
    if (marker === 'pending-implement') {
      await this.documents.putDocument(ctx.opened.run, ARTIFACTS.rebaseConflict.kind, 'review\n');
      return null;
    }
    try {
      await this.environments.check({ run: ctx.opened.run, key, step: this.name, mounts });
    } catch (error) {
      if (error instanceof RequiredCheckFailed) {
        // Git conflicts are resolved. Retry the normal implementation flow with the saved check output.
        await this.documents.putDocument(ctx.opened.run, ARTIFACTS.rebaseConflict.kind, 'review\n');
      }
      throw error;
    }
    await this.commit.publishRebased(key, branch, outcome.leases);
    await this.flows.noteFlow(key, ['code-review', 'ci'], 'code-review');
    const existing = (await this.documents.latestBody(key, ARTIFACTS.implementation.kind)) ?? '';
    if (!existing.trim()) {
      throw new SwarmloopError('implementation is missing');
    }
    const body = existing.endsWith('\n') ? existing : `${existing}\n`;
    const status = await worktreeStatus(mounts);
    return {
      route: { to: 'jump', step: 'code-review' },
      summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
      outputs: [{ artifact: ARTIFACTS.implementation, value: body }],
      handoff: '- resolved the rebase\n',
      visit: {
        documents: [
          textDocument(ARTIFACTS.rebaseConflict.kind, 'review\n'),
          textDocument(ARTIFACTS.rebaseMergeSkip.kind, 'skip\n'),
        ],
      },
    };
  }

  private failConflict(ctx: ModelStepContext, outcome: Extract<RebaseStop, { kind: 'conflict' }>): StepResult {
    const detail = [outcome.files.join(', '), outcome.stderr.trim()].filter((part) => part.length > 0).join('\n');
    const line = `${ctx.opened.startedAt} ${outcome.repo} rebase failed: ${detail}`;
    return { route: { to: 'fail', error: { code: this.name, message: line } }, summary: line, outputs: [] };
  }
}

function answerHasPlan(text: string, output: string): boolean {
  return correctedItems(text, output) !== null;
}
