import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { readEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentProcessRunner, readSession } from '../../limits/agent-runner';
import { sessionFileName } from '../../limits/session-group';
import { PipelineResult, StepOptions } from '../../pipeline/pipeline-result';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { PLAN_IMPROVE_FOLLOW_UP, withAddedRepos } from '../follow-up';
import { plainSummary, recordHandoff, skillPrompt, summaryOr, textDocument, withHandoff, withModelStep, ModelStepContext } from '../model-step';
import { mountsForStep, repoNames } from '../repo-names';
import { readPlan, reviewedItems, withPlan } from './plan-record';

@Injectable()
export class PlanImproveService {
  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly sandbox: SandboxService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
  ) {}

  execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const env = readEnv(this.config);
    return withModelStep(
      { history: this.history, sandbox: this.sandbox, agent: this.agent },
      {
        key,
        step: 'plan-improve',
        mode: 'plan',
        model: env.MODEL_PLAN,
        timeLimitMs: env.PLAN_TIMEOUT_MS,
        runtime: env.RUNTIME,
        auto: options.auto,
      },
      (ctx) => this.review(key, ctx),
    );
  }

  private async review(key: string, ctx: ModelStepContext): Promise<PipelineResult> {
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
