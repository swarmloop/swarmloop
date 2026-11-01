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
import { branchName, summaryForBranch } from '../branch/branch-name';
import { IMPLEMENT_IMPROVE_FOLLOW_UP, withAddedRepos } from '../follow-up';
import { composedReturn, ModelStepContext, plainSummary, recordHandoff, skillPrompt, summaryOr, textDocument, withHandoff, withModelStep } from '../model-step';
import { correctedPlan, requireApprovedPlan } from '../plan/plan-record';
import { mountsForStep, repoNames } from '../repo-names';
import { Step, requiredDocument } from '../step';
import { assertUncommitted, featureHeads, worktreeStatus } from '../../git/worktree-git';
import { reviewedImplementation, withReturnNotes } from './implement-record';

@Injectable()
export class ImplementImproveService implements Step {
  readonly name: StepName = 'implement-improve';
  readonly usesModel = true;

  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly sandbox: SandboxService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
  ) {}

  missingInput(key: string): Promise<string | null> {
    return requiredDocument(this.history, key, 'implementation');
  }

  execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const env = readEnv(this.config);
    return withModelStep(
      { history: this.history, sandbox: this.sandbox, agent: this.agent },
      {
        key,
        step: 'implement-improve',
        mode: 'agent',
        model: env.MODEL_IMPLEMENT,
        timeLimitMs: env.IMPLEMENT_TIMEOUT_MS,
        runtime: env.RUNTIME,
        auto: options.auto,
      },
      (ctx) => this.review(key, ctx, env, options.auto),
    );
  }

  private async review(key: string, ctx: ModelStepContext, env: SwarmloopEnv, auto?: boolean): Promise<PipelineResult> {
    const plan = requireApprovedPlan(await this.history.latestBody(key, 'requirements'));
    const notes = await this.history.latestBody(key, 'implementation');
    if (!notes?.trim()) {
      throw new SwarmloopError('implementation is missing');
    }
    const names = repoNames((await this.history.latestBody(key, 'repos')) ?? '');
    const mounts = mountsForStep(this.history.root(), key, names, ctx.opened.run.targetPath);
    if (auto && ctx.opened.run.agentCalls + 1 > env.MAX_AGENT_CALLS) {
      return ctx.end('blocked', 1, `${ctx.opened.startedAt} implement-improve does not fit`);
    }
    const returned = composedReturn(await this.history.listDocuments(ctx.opened.run.id));
    const sections = withHandoff(
      withReturnNotes(
        [
          { heading: 'Plan', body: plan },
          { heading: 'Implementation', body: notes },
        ],
        returned,
      ),
      await this.history.latestBody(key, 'handoff'),
    );
    const branch = branchName(key, summaryForBranch(ctx.requirements, key));
    const heads = await featureHeads(mounts, branch);
    const continued = await readSession(join(this.history.root(), 'data', sessionFileName(key, 'implement-improve')), ctx.opened.run.runtime);
    const full = skillPrompt('implement-improve', ctx.requirements, names, sections, mounts);
    const chosen = continued?.chatId ? IMPLEMENT_IMPROVE_FOLLOW_UP : full;
    const prompt = withAddedRepos(chosen, await this.history.latestBody(key, 'added_repos'));
    const agentResult = await ctx.launch({ prompt, mounts, allowHosts: packageRegistries() });
    const text = agentResult.responseText;
    await assertUncommitted(mounts, branch, heads);
    const wrote = reviewedImplementation(text);
    const body = wrote.trim() ? wrote : notes;
    const corrected = correctedPlan(ctx.requirements, text, agentResult.output ?? '');
    const summary = summaryOr(text, plainSummary(text) || '- checked the first pass\n');
    const handoffBody = corrected ? `${summary.trimEnd()}\n${corrected.handoff}` : summary;
    const status = await worktreeStatus(mounts);
    const line = `${ctx.opened.startedAt} implement-improve done\n${body.trimEnd()}\n${status}`;
    const handoff = await recordHandoff(this.history, key, 'implement-improve', handoffBody);
    const docs = corrected ? [handoff, textDocument('requirements', corrected.requirements)] : [handoff];
    return ctx.end('ok', 0, line, textDocument('implementation', body), docs);
  }
}
