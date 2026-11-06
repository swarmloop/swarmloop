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
import { withAddedRepos } from '../follow-up';
import { AgentStep, ModelStepContext } from '../agent-step';
import { recordHandoff, textDocument, withHandoff } from '../shared/handoff';
import { plainSummary, PLAN_EXECUTION_RULE, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { unanswered } from '../shared/answers';
import { mountsForStep, repoNames } from '../../git/repo-names';
import { planFromAgent, readPlan, withPlan } from './plan-record';
import { planFollowUp } from './plan.prompts';
import { ARTIFACTS } from '../contract/artifacts';

@Injectable()
export class PlanStep extends AgentStep {
  readonly name: StepName = 'plan';
  readonly requiredKind = ARTIFACTS.repos.kind;
  readonly revisesRequirements = true;

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

  protected async write(key: string, ctx: ModelStepContext): Promise<PipelineResult> {
    const questions = (await this.documents.latestBody(key, ARTIFACTS.questions.kind)) ?? '';
    const answers = (await this.documents.latestBody(key, ARTIFACTS.answers.kind)) ?? '';
    if (unanswered(questions, answers).length > 0) {
      return ctx.end('waiting', 0, `${ctx.opened.startedAt} questions are open`);
    }
    const requirements = (await this.documents.latestBody(key, ARTIFACTS.requirements.kind)) ?? '';
    const stored = readPlan(requirements);
    if (stored && stored.decision !== 'revise') {
      const handoff = await recordHandoff(
        this.documents,
        key,
        'plan',
        stored.items.map((item) => `- ${item}`).join('\n'),
      );
      return ctx.end(
        'ok',
        0,
        `${ctx.opened.startedAt} plan done`,
        textDocument(ARTIFACTS.requirements.kind, requirements),
        [handoff],
      );
    }
    const names = repoNames((await this.documents.latestBody(key, ARTIFACTS.repos.kind)) ?? '');
    const mounts = mountsForStep(root(this.config), key, names, ctx.opened.run.targetPath);
    const prior = await this.documents.latestBody(key, ARTIFACTS.handoff.kind);
    const sections = withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior);
    const continued = await readSession(
      join(root(this.config), 'data', sessionFileName(key, 'plan')),
      ctx.opened.run.runtime,
    );
    const full = skillPrompt('plan', ctx.requirements, names, sections, mounts);
    const chosen = continued?.chatId ? planFollowUp(answers) : full;
    const prompt = withAddedRepos(chosen, await this.documents.latestBody(key, ARTIFACTS.addedRepos.kind));
    const agentResult = await ctx.launch({ prompt: `${prompt}\n\n${PLAN_EXECUTION_RULE}`, mounts });
    const plan = planFromAgent(agentResult.responseText, agentResult.output ?? '');
    const body = withPlan(requirements, plan);
    const summary = summaryOr(
      agentResult.responseText,
      plainSummary(agentResult.responseText) || plan.items.map((item) => `- ${item}`).join('\n'),
    );
    const handoff = await recordHandoff(this.documents, key, 'plan', summary);
    return ctx.end(
      'ok',
      0,
      `${ctx.opened.startedAt} plan done\n${plan.items.join('\n')}`,
      textDocument(ARTIFACTS.requirements.kind, body),
      [handoff],
    );
  }
}
