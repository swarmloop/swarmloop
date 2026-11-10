import { agentFor } from '../../config/agents';
import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, Issue, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { SwarmloopEnv } from '../../config/env';
import { CheckoutRepository } from '../../history/checkout.repository';
import { root } from '../../history/run-paths';
import { resumableChat } from '../../agent/agent-session';
import { StepOptions, nextStep } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { branchName, commitMessage, summaryForBranch } from '../branch/branch-name';
import { isPipelineReturn, withAddedRepos } from '../follow-up';
import { git, gitDetail } from '../../git/git';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { RebasedPublisher } from '../shared/rebased-publisher';
import { pipelineAnswers, returnedNotes, textDocument, withHandoff } from '../shared/handoff';
import { parseSummary, skillPrompt } from '../shared/skill-prompt';
import { bulletList, items, section } from '../shared/markdown-section';
import { correctedItems, correctedPlan, requireApprovedPlan } from '../plan/plan-record';
import type { SandboxMount } from '../../core/sandbox-mount';
import { checkedRepoNames, mountsForStep, worktreePath } from '../../git/repo-names';
import { EnvironmentService } from '../../environment/environment.service';
import { RequiredCheckFailed, RequiredCheckRepeated } from '../../environment/project-environments';
import { withEnvironment } from '../../environment/environment-note';
import { agentWorkplace } from '../shared/agent-environment';
import { storedPlan } from '../step';
import { runJournal } from '../shared/rebase-journal';
import { RebaseStop, completeRebase, parkedConflict, rebaseFeatureRepos, unmergedPaths } from '../../git/rebase';
import { assertUncommitted, featureHeads, worktreeSnapshot, worktreeStatus } from '../../git/worktree-git';
import { staleRepos, unchangedSincePipeline } from '../pipeline/pipeline-report';
import { implementFollowUp, rebaseConflictPrompt } from './implement.prompts';
import {
  checkRepeatedBlock,
  checksLine,
  implementFacts,
  parseImplementation,
  withReturnNotes,
} from './implement-record';
import { ARTIFACTS } from '../contract/artifacts';

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
  ];

  constructor(
    kernel: StepKernel,
    sandbox: SandboxService,
    private readonly publisher: RebasedPublisher,
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
      ...agentFor(env, null, 'implement'),
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
    const sections = withHandoff(
      withReturnNotes([{ heading: 'Plan', body: plan }], notes),
      await ctx.reread(ARTIFACTS.handoff),
    );
    const branch = branchName(key, summaryForBranch(input.requirements, key));
    const markerBody = ((await ctx.reread(ARTIFACTS.rebaseConflict)) ?? '').trim();
    const marker = markerBody.split('\n')[0]?.trim() ?? '';
    const storedStderr = markerBody.split('\n').slice(1).join('\n').trim();
    const full = skillPrompt('implement', input.requirements, names, sections, mounts, { deferExecutionRules: true });
    const added = await ctx.reread(ARTIFACTS.addedRepos);
    const continued = await resumableChat(root(this.config), key, 'implement', this.profile(this.config.env).runtime);
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
    let agentResult = await ctx.launch({
      prompt,
      mounts,
      allowHosts,
      project,
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
        const line = `${ctx.opened.startedAt} pipeline failure left unfixed twice: ${repeated.title}`;
        return { route: { to: 'block', reason: line }, summary: line, outputs: [] };
      }
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
        return this.unfixedFailure(
          input.requirements,
          ctx,
          planText,
          planOutput,
          'pipeline failure left unfixed',
          pipelineIssues,
        );
      }
    }
    const text = agentResult.responseText;
    const body = parseImplementation(text);
    const { blocked, checks } = await this.gate(ctx, key, mounts);
    if (blocked) {
      return blocked;
    }
    await assertUncommitted(mounts, branch, heads);
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
      facts: implementFacts(checks),
      visit: corrected ? { documents: [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] } : undefined,
    };
  }

  /** implement-improve follows in the same pass and runs the one server gate over both passes' changes. */
  private async gate(
    ctx: ModelStepContext,
    key: string,
    mounts: SandboxMount[],
  ): Promise<{ blocked: StepResult | null; checks: string | null }> {
    if (nextStep(this.name, await this.flows.activePhases(ctx.opened.run.id)) === 'implement-improve') {
      return { blocked: null, checks: null };
    }
    try {
      const checks = await ctx.activity(
        'Server checks',
        () => this.environments.check({ run: ctx.opened.run, key, step: this.name, mounts }),
        checksLine,
      );
      return { blocked: null, checks: checksLine(checks) };
    } catch (error) {
      if (error instanceof RequiredCheckRepeated) {
        return { blocked: checkRepeatedBlock(ctx.opened.startedAt, this.name, error), checks: null };
      }
      throw error;
    }
  }

  /** A pipeline failure that the retry left unchanged on disk: stop with the corrected checklist, if one came back. */
  private unfixedFailure(
    requirements: string,
    ctx: ModelStepContext,
    planText: string,
    planOutput: string,
    text: string,
    issues: Issue[],
  ): StepResult {
    const corrected = correctedPlan(requirements, planText, planOutput);
    const line = `${ctx.opened.startedAt} ${text}`;
    const documents = [
      ...(issues.length > 0
        ? [textDocument(ARTIFACTS.unfixedIssue.kind, issues.map((issue) => issue.id).join('\n'))]
        : []),
      ...(corrected ? [textDocument(ARTIFACTS.requirements.kind, corrected.requirements)] : []),
    ];
    return {
      route: { to: 'fail', error: { code: this.name, message: line } },
      summary: line,
      outputs: [],
      handoff: corrected?.handoff,
      visit: documents.length > 0 ? { documents } : undefined,
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
      journal: runJournal(this.documents, ctx.opened.run),
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
    await completeRebase(input.journal);
    if (marker === 'pending-implement') {
      await ctx.write(ARTIFACTS.rebaseConflict, 'review\n');
      return null;
    }
    try {
      await this.environments.check({ run: ctx.opened.run, key, step: this.name, mounts });
    } catch (error) {
      if (error instanceof RequiredCheckFailed) {
        // Git conflicts are resolved. Retry the normal implementation flow with the saved check output.
        await ctx.write(ARTIFACTS.rebaseConflict, 'review\n');
      }
      throw error;
    }
    await this.publisher.publishRebased(key, branch, outcome.leases);
    await this.flows.noteFlow(key, ['code-review', 'ci'], 'code-review');
    const existing = (await ctx.reread(ARTIFACTS.implementation)) ?? '';
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
