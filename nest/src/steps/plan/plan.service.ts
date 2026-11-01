import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { readEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentProcessRunner, readSession } from '../../limits/agent-runner';
import { sessionFileName } from '../../limits/session-group';
import { PipelineResult, StepName, StepOptions } from '../../pipeline/pipeline-result';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { planFollowUp, withAddedRepos } from '../follow-up';
import { plainSummary, recordHandoff, skillPrompt, summaryOr, textDocument, withHandoff, withModelStep, ModelStepContext } from '../model-step';
import { unanswered } from '../answers';
import { mountsForStep, repoNames } from '../repo-names';
import { Step, requiredDocument } from '../step';
import { planFromAgent, readPlan, withPlan } from './plan-record';

@Injectable()
export class PlanService implements Step {
  readonly name: StepName = 'plan';
  readonly usesModel = true;

  constructor(
    private readonly history: HistoryService,
    private readonly config: ConfigService,
    private readonly sandbox: SandboxService,
    @Inject(AGENT_RUNNER) private readonly agent: AgentProcessRunner,
  ) {}

  missingInput(key: string): Promise<string | null> {
    return requiredDocument(this.history, key, 'repos');
  }

  execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const env = readEnv(this.config);
    return withModelStep(
      { history: this.history, sandbox: this.sandbox, agent: this.agent },
      {
        key,
        step: 'plan',
        mode: 'plan',
        model: env.MODEL_PLAN,
        timeLimitMs: env.PLAN_TIMEOUT_MS,
        runtime: env.RUNTIME,
        auto: options.auto,
      },
      (ctx) => this.write(key, ctx),
    );
  }

  private async write(key: string, ctx: ModelStepContext): Promise<PipelineResult> {
    const questions = (await this.history.latestBody(key, 'questions')) ?? '';
    const answers = (await this.history.latestBody(key, 'answers')) ?? '';
    if (unanswered(questions, answers).length > 0) {
      return ctx.end('waiting', 0, `${ctx.opened.startedAt} questions are open`);
    }
    const requirements = (await this.history.latestBody(key, 'requirements')) ?? '';
    const stored = readPlan(requirements);
    if (stored && stored.decision !== 'revise') {
      const handoff = await recordHandoff(this.history, key, 'plan', stored.items.map((item) => `- ${item}`).join('\n'));
      return ctx.end('ok', 0, `${ctx.opened.startedAt} plan done`, textDocument('requirements', requirements), [handoff]);
    }
    const names = repoNames((await this.history.latestBody(key, 'repos')) ?? '');
    const mounts = mountsForStep(this.history.root(), key, names, ctx.opened.run.targetPath);
    const prior = await this.history.latestBody(key, 'handoff');
    const sections = withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior);
    const continued = await readSession(join(this.history.root(), 'data', sessionFileName(key, 'plan')), ctx.opened.run.runtime);
    const full = skillPrompt('plan', ctx.requirements, names, sections, mounts);
    const chosen = continued?.chatId ? planFollowUp(answers) : full;
    const prompt = withAddedRepos(chosen, await this.history.latestBody(key, 'added_repos'));
    const agentResult = await ctx.launch({ prompt, mounts });
    const plan = planFromAgent(agentResult.responseText, agentResult.output ?? '');
    const body = withPlan(requirements, plan);
    const summary = summaryOr(agentResult.responseText, plainSummary(agentResult.responseText) || plan.items.map((item) => `- ${item}`).join('\n'));
    const handoff = await recordHandoff(this.history, key, 'plan', summary);
    return ctx.end('ok', 0, `${ctx.opened.startedAt} plan done\n${plan.items.join('\n')}`, textDocument('requirements', body), [handoff]);
  }
}
