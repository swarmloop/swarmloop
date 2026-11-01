import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentProcessRunner, readSession } from '../../limits/agent-runner';
import { sessionFileName } from '../../limits/session-group';
import { PipelineResult, StepName } from '../../pipeline/pipeline-result';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { withAddedRepos } from '../follow-up';
import { AgentStep, ModelStepContext } from '../agent-step';
import { recordHandoff, textDocument, withHandoff } from '../shared/handoff';
import { plainSummary, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { mountsForStep, repoNames } from '../shared/repo-names';
import { storedPlan } from '../step';
import { readPlan, reviewedItems, withPlan } from './plan-record';
import { PLAN_IMPROVE_FOLLOW_UP } from '../plan-improve/plan-improve.prompts';

@Injectable()
export class PlanImproveService extends AgentStep {
  readonly name: StepName = 'plan-improve';
  readonly requiredKind = 'plan';

  constructor(
    history: HistoryService,
    config: ConfigService,
    sandbox: SandboxService,
    @Inject(AGENT_RUNNER) agent: AgentProcessRunner,
  ) {
    super(history, config, sandbox, agent);
  }

  protected settings(env: SwarmloopEnv): { mode: string; model: string; timeLimitMs: number } {
    return { mode: 'plan', model: env.MODEL_PLAN, timeLimitMs: env.PLAN_TIMEOUT_MS };
  }

  missingInput(key: string): Promise<string | null> {
    return storedPlan(this.history, key);
  }

  protected async write(key: string, ctx: ModelStepContext): Promise<PipelineResult> {
    const requirements = (await this.history.latestBody(key, 'requirements')) ?? '';
    const plan = readPlan(requirements);
    if (!plan) {
      throw new SwarmloopError('plan is missing');
    }
    const names = repoNames((await this.history.latestBody(key, 'repos')) ?? '');
    const mounts = mountsForStep(this.history.root(), key, names, ctx.opened.run.targetPath);
    const prior = await this.history.latestBody(key, 'handoff');
    const continued = await readSession(join(this.history.root(), 'data', sessionFileName(key, 'plan-improve')), ctx.opened.run.runtime);
    const full = skillPrompt(
      'plan-improve',
      ctx.requirements,
      names,
      withHandoff([{ heading: 'Plan', body: JSON.stringify(plan, null, 2) }], prior),
      mounts,
    );
    const chosen = continued?.chatId ? PLAN_IMPROVE_FOLLOW_UP : full;
    const prompt = withAddedRepos(chosen, await this.history.latestBody(key, 'added_repos'));
    const agentResult = await ctx.launch({ prompt, mounts });
    const items = reviewedItems(agentResult.responseText, agentResult.output ?? '');
    const next = { ...plan, items: items.length > 0 ? items : plan.items, decision: 'approve' as const };
    const summary = summaryOr(agentResult.responseText, plainSummary(agentResult.responseText) || next.items.map((item) => `- ${item}`).join('\n'));
    const handoff = await recordHandoff(this.history, key, 'plan-improve', summary);
    return ctx.end('ok', 0, `${ctx.opened.startedAt} plan-improve done\n${next.items.join('\n')}`, textDocument('requirements', withPlan(requirements, next)), [
      handoff,
    ]);
  }
}
