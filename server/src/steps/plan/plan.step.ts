import { Inject, Injectable } from '@nestjs/common';
import type { StepCapabilities } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
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
  override readonly capabilities: StepCapabilities = { revisesRequirements: true };

  constructor(kernel: StepKernel, sandbox: SandboxService, @Inject(AGENT_RUNNER) agent: AgentProcessRunner) {
    super(kernel, sandbox, agent);
  }

  protected settings(env: SwarmloopEnv): { mode: string; model: string; timeLimitMs: number } {
    return { mode: 'plan', model: env.MODEL_PLAN, timeLimitMs: env.PLAN_TIMEOUT_MS };
  }

  protected async write(key: string, ctx: ModelStepContext): Promise<PipelineResult> {
    const questions = (await this.documents.latestBody(key, ARTIFACTS.questions.kind)) ?? '';
    const answers = (await this.documents.latestBody(key, ARTIFACTS.answers.kind)) ?? '';
    if (unanswered(questions, answers).length > 0) {
      return ctx.end({ outcome: 'waiting', exitCode: 0, line: `${ctx.opened.startedAt} questions are open` });
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
      return ctx.end({
        outcome: 'ok',
        exitCode: 0,
        line: `${ctx.opened.startedAt} plan done`,
        document: textDocument(ARTIFACTS.requirements.kind, requirements),
        documents: [handoff],
      });
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
    return ctx.end({
      outcome: 'ok',
      exitCode: 0,
      line: `${ctx.opened.startedAt} plan done\n${plan.items.join('\n')}`,
      document: textDocument(ARTIFACTS.requirements.kind, body),
      documents: [handoff],
    });
  }
}
