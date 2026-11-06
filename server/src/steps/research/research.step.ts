import { Inject, Injectable } from '@nestjs/common';
import type { StepCapabilities } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { existsSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { AGENT_RUNNER, AgentProcessRunner } from '../../agent/agent-runner';
import { PipelineResult } from '../../core/pipeline-result';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { renderProjects, storedProjects } from '../prepare/checkout-path';
import { AgentStep, ModelStepContext } from '../agent-step';
import { recordHandoff, textDocument, withHandoff } from '../shared/handoff';
import { plainSummary, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { mountsForStep } from '../../git/repo-names';
import { parseResearch } from './research-record';
import { RESEARCH_CONTINUE } from './research.prompts';
import { ARTIFACTS } from '../contract/artifacts';

@Injectable()
export class ResearchStep extends AgentStep {
  readonly name: StepName = 'research';
  readonly requiredKind = 'worktrees';
  override readonly capabilities: StepCapabilities = { revisesRequirements: true };

  constructor(kernel: StepKernel, sandbox: SandboxService, @Inject(AGENT_RUNNER) agent: AgentProcessRunner) {
    super(kernel, sandbox, agent);
  }

  protected settings(env: SwarmloopEnv): { mode: string; model: string; timeLimitMs: number } {
    return { mode: 'plan', model: env.MODEL_PLAN, timeLimitMs: env.RESEARCH_TIMEOUT_MS };
  }

  override missingInput(key: string): Promise<string | null> {
    return Promise.resolve(existsSync(join(root(this.config), 'worktrees', key)) ? null : `worktrees/${key}`);
  }

  protected async write(key: string, ctx: ModelStepContext): Promise<PipelineResult> {
    const stored = storedProjects(ctx.opened.run.projects);
    const names = stored.length > 0 ? stored : listWorktrees(ctx.workspace);
    if (names.length === 0) {
      throw new SwarmloopError('worktrees is empty');
    }
    const answers = (await this.documents.latestBody(ctx.opened.run.key, ARTIFACTS.answers.kind)) ?? '';
    const prior = await this.documents.latestBody(ctx.opened.run.key, ARTIFACTS.handoff.kind);
    const sections = withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior);
    const mounts = mountsForStep(root(this.config), ctx.opened.run.key, names, null);
    const full = skillPrompt('research', ctx.requirements, names, sections, mounts);
    const agentResult = await ctx.launch({ prompt: full, mounts, continuePrompt: RESEARCH_CONTINUE });
    const parsed = parseResearch(agentResult.responseText);
    const repos = renderProjects(names);
    const paused = parsed.questions !== '';
    await this.documents.putDocument(ctx.opened.run, ARTIFACTS.repos.kind, repos);
    const detail = (paused ? parsed.questions : repos).trimEnd();
    const word = paused ? 'waiting' : 'done';
    const summary = summaryOr(
      agentResult.responseText,
      plainSummary(agentResult.responseText) || `- chose ${repos.trim().split('\n').join(', ')}`,
    );
    const handoff = await recordHandoff(this.documents, ctx.opened.run.key, 'research', summary);
    return ctx.end({
      outcome: paused ? 'waiting' : 'ok',
      exitCode: 0,
      line: `${ctx.opened.startedAt} research ${word}\n${detail}`,
      document: textDocument(ARTIFACTS.questions.kind, parsed.questions),
      documents: [handoff],
    });
  }
}

function listWorktrees(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    throw new SwarmloopError('worktrees is not readable');
  }
  const dirs = names.filter((name) => !name.startsWith('.') && statSync(join(directory, name)).isDirectory()).sort();
  return dirs.length > 0 ? dirs : [basename(directory)];
}
