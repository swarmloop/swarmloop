import { agentFor } from '../../config/agents';
import type { RunEntity } from '../../history/entities';
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
import { renderProjects, storedProjects } from '../../config/checkout-path';
import { AgentStep, instructionsInput, lateInput, ModelStepContext, REQUIREMENTS_INPUT } from '../agent-step';
import { AgentLauncher } from '../shared/agent-launcher';
import { isSubtask } from '../../contract/subtask';
import { assumptions, withContract, withHandoff } from '../shared/handoff';
import { skillPrompt } from '../shared/skill-prompt';
import { resumableChat } from '../../agent/agent-session';
import { projectRules } from '../shared/project-rules';
import { mountsForStep } from '../../git/repo-names';
import { renderImpact, renderQuestions } from './research-record';
import { needsWait } from '../shared/needs';
import { researchContinue } from './research.prompts';
import { research, type ResearchResult } from '../../agent-result/definitions/research';
import { resultPromptFor } from '../../agent-result/result-prompt';
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

  readonly outputs = [
    ARTIFACTS.questions,
    ARTIFACTS.repos,
    ARTIFACTS.impact,
    ARTIFACTS.needs,
    ARTIFACTS.researchResult,
  ];

  constructor(kernel: StepKernel, sandbox: SandboxService, launcher: AgentLauncher) {
    super(kernel, sandbox, launcher);
  }

  protected profile(env: SwarmloopEnv, run?: RunEntity | null): AgentProfile {
    return {
      ...agentFor(env, run ?? null, 'research'),
      mode: 'plan',
      tools: 'plan',
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
    const sections = withContract(
      withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior),
      await this.parentContract(ctx.opened.run),
    );
    const mounts = mountsForStep(root(this.config), ctx.opened.run.key, names, null);
    // Research shares a chat with plan; its session records which definition was actually sent last.
    const promptFor = (runtime: string, received: string | null, resumed = false): string =>
      [
        skillPrompt('research', input.requirements, names, sections, mounts, {
          rules: projectRules(names, mounts, runtime, resumed),
        }),
        resultPromptFor(research, received),
      ].join('\n\n');
    const { runtime } = this.profile(this.config.env, ctx.opened.run);
    const chat = await resumableChat(root(this.config), ctx.opened.run.key, 'research', runtime);
    const received = chat?.chatId ? (chat.resultName ?? null) : null;
    const subtask = isSubtask(ctx.opened.run);
    const agentResult = await ctx.launch({
      prompt: promptFor(runtime, received, Boolean(chat?.chatId)),
      briefFor: (other) => promptFor(other, null),
      mounts,
      continuePrompt: researchContinue(research.name),
      result: research,
    });
    const result = agentResult.resultValue as ResearchResult;
    const needs = subtask ? (result.needs ?? []) : [];
    if (needs.length > 0) {
      await ctx.write(ARTIFACTS.repos, ARTIFACTS.repos.parse(renderProjects(names)));
      const wait = needsWait(ctx.opened.startedAt, needs);
      return {
        ...wait,
        outputs: [
          { artifact: ARTIFACTS.questions, value: '' },
          ...wait.outputs,
          { artifact: ARTIFACTS.researchResult, value: result },
        ],
      };
    }
    if (subtask) await ctx.write(ARTIFACTS.needs, '');
    const questions = renderQuestions(result.questions);
    const repos = renderProjects(names);
    // A subtask waits once, and only while its parent's planner can answer. Otherwise it decides its questions
    // itself and records them as assumptions: no subtask waits for a person.
    const { run } = ctx.opened;
    const parent = isSubtask(run) ? await this.runs.findById(run.parentRunId as number) : null;
    const paused = questions !== '' && (!subtask || (parent?.split === true && !answers.trim()));
    const assumed = subtask && !paused ? assumptions(questions) : '';
    await ctx.write(ARTIFACTS.repos, ARTIFACTS.repos.parse(repos));
    const detail = (paused ? questions : repos).trimEnd();
    const word = paused ? 'waiting' : 'done';
    const summary = [
      result.summary.length > 0
        ? `${result.summary.map((line) => `- ${line}`).join('\n')}\n`
        : `- chose ${repos.trim().split('\n').join(', ')}`,
      assumed,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      route: paused ? { to: 'wait', reason: 'questions are open' } : { to: 'next' },
      summary: `${ctx.opened.startedAt} research ${word}\n${detail}`,
      outputs: [
        { artifact: ARTIFACTS.questions, value: subtask && !paused ? '' : questions },
        { artifact: ARTIFACTS.impact, value: renderImpact(result.impact) },
        { artifact: ARTIFACTS.researchResult, value: result },
      ],
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
