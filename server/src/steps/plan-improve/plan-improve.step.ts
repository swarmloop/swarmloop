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
import { sessionFileName } from '../../history/session-group';
import { PipelineResult } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { withAddedRepos } from '../follow-up';
import { AgentStep, ModelStepContext } from '../agent-step';
import { recordHandoff, textDocument, withHandoff } from '../shared/handoff';
import { plainSummary, PLAN_EXECUTION_RULE, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { mountsForStep, repoNames } from '../../git/repo-names';
import { storedPlan } from '../step';
import { readPlan, reviewedItems, withPlan } from '../plan/plan-record';
import { PLAN_IMPROVE_FOLLOW_UP } from './plan-improve.prompts';
import { ARTIFACTS } from '../contract/artifacts';

@Injectable()
export class PlanImproveStep extends AgentStep {
  readonly name: StepName = 'plan-improve';
  readonly requiredKind = 'plan';

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
    return { mode: 'plan', model: env.MODEL_PLAN, timeLimitMs: env.PLAN_TIMEOUT_MS };
  }

  override missingInput(key: string): Promise<string | null> {
    return storedPlan(this.documents, key);
  }

  protected async write(key: string, ctx: ModelStepContext): Promise<PipelineResult> {
    const requirements = (await this.documents.latestBody(key, ARTIFACTS.requirements.kind)) ?? '';
    const plan = readPlan(requirements);
    if (!plan) {
      throw new SwarmloopError('plan is missing');
    }
    const names = repoNames((await this.documents.latestBody(key, ARTIFACTS.repos.kind)) ?? '');
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    const prior = await this.documents.latestBody(key, ARTIFACTS.handoff.kind);
    const continued = await readSession(
      join(root(this.config), 'data', sessionFileName(key, 'plan-improve')),
      ctx.opened.run.runtime,
    );
    const full = skillPrompt(
      'plan-improve',
      ctx.requirements,
      names,
      withHandoff([{ heading: 'Plan', body: JSON.stringify(plan, null, 2) }], prior),
      mounts,
    );
    const chosen = continued?.chatId ? PLAN_IMPROVE_FOLLOW_UP : full;
    const prompt = withAddedRepos(chosen, await this.documents.latestBody(key, ARTIFACTS.addedRepos.kind));
    const agentResult = await ctx.launch({ prompt: `${prompt}\n\n${PLAN_EXECUTION_RULE}`, mounts });
    const items = reviewedItems(agentResult.responseText, agentResult.output ?? '');
    const next = { ...plan, items: items.length > 0 ? items : plan.items, decision: 'approve' as const };
    const summary = summaryOr(
      agentResult.responseText,
      plainSummary(agentResult.responseText) || next.items.map((item) => `- ${item}`).join('\n'),
    );
    const handoff = await recordHandoff(this.documents, key, 'plan-improve', summary);
    return ctx.end(
      'ok',
      0,
      `${ctx.opened.startedAt} plan-improve done\n${next.items.join('\n')}`,
      textDocument(ARTIFACTS.requirements.kind, withPlan(requirements, next)),
      [handoff],
    );
  }
}
