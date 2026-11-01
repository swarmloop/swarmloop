import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { readEnv, SwarmloopEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentProcessRunner, readSession } from '../../limits/agent-runner';
import { sessionFileName } from '../../limits/session-group';
import { PipelineResult, StepName, StepOptions } from '../../pipeline/pipeline-result';
import { packageRegistries } from '../../sandbox/sandbox-launch';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { branchName, commitMessage, summaryForBranch } from '../branch/branch-name';
import { CommitService } from '../commit/commit.service';
import { implementFollowUp, isPipelineReturn, rebaseConflictPrompt, withAddedRepos } from '../follow-up';
import { git, gitDetail } from '../../git/git';
import { ModelStepContext, withModelStep } from '../agent-step';
import { composedReturn, recordHandoff, textDocument, withHandoff } from '../shared/handoff';
import { parseSummary, skillPrompt } from '../shared/skill-prompt';
import { REBASE_MERGE_SKIP } from '../merge-request/merge-request.service';
import { correctedItems, correctedPlan, requireApprovedPlan } from '../plan/plan-record';
import { mountsForStep, repoNames, worktreePath } from '../shared/repo-names';
import { Step, storedPlan } from '../step';
import { REBASE_CONFLICT, RebaseStop, parkedConflict, rebaseFeatureRepos, unmergedPaths } from '../../git/rebase-worktree';
import { assertUncommitted, featureHeads, worktreeSnapshot, worktreeStatus } from '../../git/worktree-git';
import { parseImplementation, withReturnNotes } from './implement-record';

@Injectable()
export class ImplementService implements Step {
  readonly name: StepName = 'implement';
  readonly usesModel = true;

  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly sandbox: SandboxService,
    private readonly commit: CommitService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
  ) {}

  missingInput(key: string): Promise<string | null> {
    return storedPlan(this.history, key);
  }

  execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const env = readEnv(this.config);
    return withModelStep(
      { history: this.history, sandbox: this.sandbox, agent: this.agent },
      {
        key,
        step: 'implement',
        mode: 'agent',
        model: env.MODEL_IMPLEMENT,
        timeLimitMs: env.IMPLEMENT_TIMEOUT_MS,
        runtime: env.RUNTIME,
        auto: options.auto,
      },
      (ctx) => this.apply(key, ctx, env, options.auto),
    );
  }

  private async apply(key: string, ctx: ModelStepContext, env: SwarmloopEnv, auto?: boolean): Promise<PipelineResult> {
    const plan = requireApprovedPlan(await this.history.latestBody(key, 'requirements'));
    const names = repoNames((await this.history.latestBody(key, 'repos')) ?? '');
    const mounts = mountsForStep(this.history.root(), key, names, ctx.opened.run.targetPath);
    if (auto && ctx.opened.run.agentCalls + 1 > env.MAX_AGENT_CALLS) {
      return ctx.end('blocked', 1, `${ctx.opened.startedAt} implement does not fit`);
    }
    const notes = composedReturn(await this.history.listDocuments(ctx.opened.run.id));
    const sections = withHandoff(
      withReturnNotes([{ heading: 'Plan', body: plan }], notes),
      await this.history.latestBody(key, 'handoff'),
    );
    const branch = branchName(key, summaryForBranch(ctx.requirements, key));
    const markerBody = ((await this.history.latestBody(key, REBASE_CONFLICT)) ?? '').trim();
    const marker = markerBody.split('\n')[0]?.trim() ?? '';
    const storedStderr = markerBody.split('\n').slice(1).join('\n').trim();
    const full = skillPrompt('implement', ctx.requirements, names, sections, mounts);
    const added = await this.history.latestBody(key, 'added_repos');
    const continued = await readSession(join(this.history.root(), 'data', sessionFileName(key, 'implement')), ctx.opened.run.runtime);
    const basePrompt = withAddedRepos(continued?.chatId ? implementFollowUp(plan, notes) : full, added);
    if (marker === 'pending' || marker === 'pending-implement') {
      const settled = await this.settleRebase(key, ctx, marker, names, branch, storedStderr);
      if (settled) {
        return settled;
      }
    }
    const heads = await featureHeads(mounts, branch);
    const prompt = basePrompt;
    const before = await worktreeSnapshot(mounts);
    let agentResult = await ctx.launch({ prompt, mounts, allowHosts: packageRegistries() });
    await assertUncommitted(mounts, branch, heads);
    let planText = agentResult.responseText;
    let planOutput = agentResult.output ?? '';
    if (isPipelineReturn(notes) && (await worktreeSnapshot(mounts)) === before) {
      agentResult = await ctx.launch({
        prompt: `The pipeline failure still stands and the files are unchanged.\n\n${notes?.trim() ?? ''}`,
        mounts,
        allowHosts: packageRegistries(),
      });
      await assertUncommitted(mounts, branch, heads);
      const againOutput = agentResult.output ?? '';
      if (answerHasPlan(agentResult.responseText, againOutput)) {
        planText = agentResult.responseText;
        planOutput = againOutput;
      }
      if ((await worktreeSnapshot(mounts)) === before) {
        const corrected = correctedPlan(ctx.requirements, planText, planOutput);
        const docs = corrected
          ? [await recordHandoff(this.history, key, 'implement', corrected.handoff), textDocument('requirements', corrected.requirements)]
          : undefined;
        return ctx.end('failed', 1, `${ctx.opened.startedAt} pipeline failure left unfixed`, undefined, docs);
      }
    }
    const text = agentResult.responseText;
    const body = parseImplementation(text);
    const corrected = correctedPlan(ctx.requirements, planText, planOutput);
    const summary = corrected ? `${parseSummary(text).trimEnd()}\n${corrected.handoff}` : parseSummary(text);
    const status = await worktreeStatus(mounts);
    const handoff = await recordHandoff(this.history, key, 'implement', summary);
    const docs = corrected ? [handoff, textDocument('requirements', corrected.requirements)] : [handoff];
    return ctx.end(
      'ok',
      0,
      `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
      textDocument('implementation', body),
      docs,
    );
  }

  /** Finish an open rebase in nest. A stored checklist then goes to code review; an unfinished one returns to the checklist prompt. */
  private async settleRebase(
    key: string,
    ctx: ModelStepContext,
    marker: string,
    names: string[],
    branch: string,
    storedStderr: string,
  ): Promise<PipelineResult | null> {
    const input = {
      root: this.history.root(),
      key,
      repos: names,
      branch,
      prompt: ctx.opened.run.prompt,
      denied: await this.history.listDenyPaths(),
      message: commitMessage(key, summaryForBranch(ctx.requirements, key)),
      hosts: readEnv(this.config),
    };
    const mounts = mountsForStep(this.history.root(), key, names, ctx.opened.run.targetPath);
    let outcome: RebaseStop | null = null;
    for (const repo of names) {
      const parked = await parkedConflict(worktreePath(this.history.root(), key, repo), repo, ctx.opened.run.prompt);
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
      await ctx.launch({
        prompt: `${rebaseConflictPrompt({
          repo: outcome.repo,
          files: outcome.files,
          requirements: ctx.requirements,
          base: outcome.base,
          commit: outcome.commit,
        })}\n`,
        mounts,
        allowHosts: packageRegistries(),
        resume: false,
      });
      const cwd = worktreePath(this.history.root(), key, outcome.repo);
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
    if (marker === 'pending-implement') {
      await this.history.putDocument(ctx.opened.run, REBASE_CONFLICT, 'review\n');
      return null;
    }
    await this.commit.publishRebased(key, branch, outcome.leases);
    await this.history.noteFlow(key, ['code-review', 'ci'], 'code-review');
    const existing = (await this.history.latestBody(key, 'implementation')) ?? '';
    if (!existing.trim()) {
      throw new SwarmloopError('implementation is missing');
    }
    const body = existing.endsWith('\n') ? existing : `${existing}\n`;
    const status = await worktreeStatus(mounts);
    const handoff = await recordHandoff(this.history, key, 'implement', '- resolved the rebase\n');
    return ctx.end(
      'ok',
      0,
      `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
      textDocument('implementation', body),
      [handoff, textDocument(REBASE_CONFLICT, 'review\n'), textDocument(REBASE_MERGE_SKIP, 'skip\n')],
      'code-review',
    );
  }

  private failConflict(ctx: ModelStepContext, outcome: Extract<RebaseStop, { kind: 'conflict' }>): Promise<PipelineResult> {
    const detail = [outcome.files.join(', '), outcome.stderr.trim()].filter((part) => part.length > 0).join('\n');
    return ctx.end('failed', 1, `${ctx.opened.startedAt} ${outcome.repo} rebase failed: ${detail}`);
  }
}

function answerHasPlan(text: string, output: string): boolean {
  return correctedItems(text, output) !== null;
}
