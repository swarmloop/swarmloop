import { Injectable } from '@nestjs/common';
import type { AgentProfile, InputSpec, StepCapabilities, StepInput, StepResult } from '../contract/step-contract';
import { StepKernel } from '../step-kernel';
import { existsSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { root } from '../../history/run-paths';
import { StepName } from '../../contract/steps';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../core/swarmloop-error';
import { renderProjects, storedProjects } from '../prepare/checkout-path';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { withHandoff } from '../shared/handoff';
import { plainSummary, skillPrompt, summaryOr } from '../shared/skill-prompt';
import { mountsForStep } from '../../git/repo-names';
import { parseResearch } from './research-record';
import { RESEARCH_CONTINUE } from './research.prompts';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  answers: lateInput(ARTIFACTS.answers),
  repos: lateInput(ARTIFACTS.repos),
  instructions: instructionsInput('research'),
} as const satisfies InputSpec;

@Injectable()
export class ResearchStep extends AgentStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly name: StepName = 'research';
  override readonly capabilities: StepCapabilities = { revisesRequirements: true };

  readonly outputs = [ARTIFACTS.questions, ARTIFACTS.repos];

  constructor(kernel: StepKernel, sandbox: SandboxService, launcher: AgentLauncher) {
    super(kernel, sandbox, launcher);
  }

  protected profile(env: SwarmloopEnv): AgentProfile {
    return {
      runtime: env.RUNTIME,
      model: env.MODEL_PLAN,
      mode: 'plan',
      timeLimitMs: env.RESEARCH_TIMEOUT_MS,
      session: 'resume',
    };
  }

  override missingInput(key: string): Promise<string | null> {
    return Promise.resolve(existsSync(join(root(this.config), 'worktrees', key)) ? null : `worktrees/${key}`);
  }

  protected async produce(input: StepInput<typeof INPUTS>, ctx: ModelStepContext): Promise<StepResult> {
    const stored = storedProjects(ctx.opened.run.projects);
    const names = stored.length > 0 ? stored : listWorktrees(ctx.workspace);
    if (names.length === 0) {
      throw new SwarmloopError('worktrees is empty');
    }
    const answers = (await ctx.reread(ARTIFACTS.answers)) ?? '';
    const prior = await ctx.reread(ARTIFACTS.handoff);
    const sections = withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior);
    const mounts = mountsForStep(root(this.config), ctx.opened.run.key, names, null);
    const full = skillPrompt('research', input.requirements, names, sections, mounts);
    const agentResult = await ctx.launch({ prompt: full, mounts, continuePrompt: RESEARCH_CONTINUE, sections: ['questions'] });
    const parsed = parseResearch(agentResult.responseText);
    const repos = renderProjects(names);
    const paused = parsed.questions !== '';
    await ctx.write(ARTIFACTS.repos, ARTIFACTS.repos.parse(repos));
    const detail = (paused ? parsed.questions : repos).trimEnd();
    const word = paused ? 'waiting' : 'done';
    const summary = summaryOr(
      agentResult.responseText,
      plainSummary(agentResult.responseText) || `- chose ${repos.trim().split('\n').join(', ')}`,
    );
    return {
      route: paused ? { to: 'wait', reason: 'questions are open' } : { to: 'next' },
      summary: `${ctx.opened.startedAt} research ${word}\n${detail}`,
      outputs: [{ artifact: ARTIFACTS.questions, value: parsed.questions }],
      handoff: summary,
    };
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
