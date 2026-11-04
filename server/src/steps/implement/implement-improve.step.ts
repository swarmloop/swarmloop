import { Inject, Injectable } from '@nestjs/common';
import { join } from 'path';
import { AppConfig, SwarmloopEnv } from '../../config/env';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import { VisitRepository } from '../../history/visit.repository';
import { FlowRepository } from '../../history/flow.repository';
import { root } from '../../history/run-paths';
import { Clock } from '../../core/clock';
import { AGENT_RUNNER, AgentProcessRunner, readSession } from '../../agent/agent-runner';
import { sessionFileName } from '../../agent/session-group';
import { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { packageRegistries } from '../../sandbox/sandbox-launch';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { branchName, summaryForBranch } from '../branch/branch-name';
import { withAddedRepos } from '../follow-up';
import { AgentStep, ModelStepContext } from '../agent-step';
import { composedReturn, recordHandoff, textDocument, withHandoff } from '../shared/handoff';
import { plainSummary, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { correctedPlan, requireApprovedPlan } from '../plan/plan-record';
import { mountsForStep, repoNames } from '../shared/repo-names';
import { verifyNote, withVerifyNote } from '../verify/verify-note';
import { assertUncommitted, featureHeads, worktreeStatus } from '../../git/worktree-git';
import { IMPLEMENT_IMPROVE_FOLLOW_UP } from './implement.prompts';
import { reviewedImplementation, withReturnNotes } from './implement-record';

@Injectable()
export class ImplementImproveStep extends AgentStep {
  readonly name: StepName = 'implement-improve';
  readonly requiredKind = 'implementation';

  constructor(
    runs: RunRepository,
    documents: DocumentRepository,
    visits: VisitRepository,
    flows: FlowRepository,
    clock: Clock,
    config: AppConfig,
    sandbox: SandboxService,
    @Inject(AGENT_RUNNER) agent: AgentProcessRunner,
  ) {
    super(runs, documents, visits, flows, clock, config, sandbox, agent);
  }

  protected settings(env: SwarmloopEnv): { mode: string; model: string; timeLimitMs: number } {
    return { mode: 'agent', model: env.MODEL_IMPLEMENT, timeLimitMs: env.IMPLEMENT_TIMEOUT_MS };
  }

  protected async write(key: string, ctx: ModelStepContext, options: StepOptions): Promise<PipelineResult> {
    const env = this.config.env;
    const auto = options.auto;
    const plan = requireApprovedPlan(await this.documents.latestBody(key, 'requirements'));
    const notes = await this.documents.latestBody(key, 'implementation');
    if (!notes?.trim()) {
      throw new SwarmloopError('implementation is missing');
    }
    const names = repoNames((await this.documents.latestBody(key, 'repos')) ?? '');
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    if (auto && ctx.opened.run.agentCalls + 1 > env.MAX_AGENT_CALLS) {
      return ctx.end('blocked', 1, `${ctx.opened.startedAt} implement-improve does not fit`);
    }
    const returned = composedReturn(await this.documents.listDocuments(ctx.opened.run.id));
    const sections = withHandoff(
      withReturnNotes(
        [
          { heading: 'Plan', body: plan },
          { heading: 'Implementation', body: notes },
        ],
        returned,
      ),
      await this.documents.latestBody(key, 'handoff'),
    );
    const branch = branchName(key, summaryForBranch(ctx.requirements, key));
    const heads = await featureHeads(mounts, branch);
    const continued = await readSession(
      join(root(this.config), 'data', sessionFileName(key, 'implement-improve')),
      ctx.opened.run.runtime,
    );
    const full = skillPrompt('implement-improve', ctx.requirements, names, sections, mounts);
    const chosen = continued?.chatId ? IMPLEMENT_IMPROVE_FOLLOW_UP : full;
    const prompt = withVerifyNote(
      withAddedRepos(chosen, await this.documents.latestBody(key, 'added_repos')),
      await verifyNote(mounts),
    );
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
    const handoff = await recordHandoff(this.documents, key, 'implement-improve', handoffBody);
    const docs = corrected ? [handoff, textDocument('requirements', corrected.requirements)] : [handoff];
    return ctx.end('ok', 0, line, textDocument('implementation', body), docs);
  }
}
