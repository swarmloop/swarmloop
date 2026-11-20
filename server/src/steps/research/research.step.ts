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
import { CONTRACT_KIND, isSubtask, parseSubtasks, SUBTASKS_KIND } from '../../contract/subtask';
import { assumptions, withHandoff } from '../shared/handoff';
import { skillPrompt } from '../shared/skill-prompt';
import { resumableChat } from '../../agent/agent-session';
import { projectRules } from '../shared/project-rules';
import { mountsForStep } from '../../git/repo-names';
import { renderImpact, renderQuestions } from './research-record';
import { StarterExchange } from '../shared/starter-exchange';
import { researchContinue } from './research.prompts';
import { researchFor, type ResearchResult } from '../../agent-result/definitions/research';
import { requirementErrors, requirementsToWrite } from './research-requirements';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { runTitle } from '../../contract/requirements-view';
import { ARTIFACTS } from '../contract/artifacts';

const INPUTS = {
  requirements: REQUIREMENTS_INPUT,
  answers: lateInput(ARTIFACTS.answers),
  repos: lateInput(ARTIFACTS.repos),
  requirementList: lateInput(ARTIFACTS.requirementList),
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
    ARTIFACTS.requirementList,
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
    const sections = withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior);
    const mounts = mountsForStep(root(this.config), ctx.opened.run.key, names, null);
    const subtask = isSubtask(ctx.opened.run);
    const asked = researchFor(subtask);
    const storedList = await ctx.reread(ARTIFACTS.requirementList);
    // Research shares a chat with plan; its session records which definition was actually sent last.
    const promptFor = (runtime: string, received: string | null, resumed = false): string =>
      [
        skillPrompt('research', input.requirements, names, sections, mounts, {
          rules: projectRules(names, mounts, runtime, resumed),
        }),
        resultPromptFor(asked, received),
      ].join('\n\n');
    const { runtime } = this.profile(this.config.env, ctx.opened.run);
    const chat = await resumableChat(root(this.config), ctx.opened.run.key, 'research', runtime);
    const received = chat?.chatId ? (chat.resultName ?? null) : null;
    // A subtask hands back what it asks, decides and leaves out through the one exchange; a run that is not a subtask asks a person.
    const exchange = new StarterExchange(undefined, this.clock);
    const contract = subtask ? await this.parentDocument(ctx.opened.run, CONTRACT_KIND) : null;
    const agentResult = await ctx.launch({
      prompt: promptFor(runtime, received, Boolean(chat?.chatId)),
      briefFor: (other) => promptFor(other, null),
      mounts,
      continuePrompt: researchContinue(asked),
      briefing: { continued: chat !== null },
      result: asked,
      check: (raw) =>
        subtask
          ? exchange.check(ctx.opened.run, raw as ResearchResult, contract)
          : requirementErrors(storedList, (raw as ResearchResult).requirements),
    });
    // A subtask asks `question`: its result has no `questions`.
    const given = agentResult.resultValue as ResearchResult;
    const result: ResearchResult = subtask ? { ...given, questions: [] } : given;
    if (result.title?.trim()) {
      await this.runs.recordTitle(ctx.opened.run, runTitle(result.title));
    }
    const { run } = ctx.opened;
    const repos = renderProjects(names);
    const parentList = await this.parentDocument(run, ARTIFACTS.requirementList.kind);
    const list = requirementsToWrite({
      stored: storedList,
      answered: result.requirements,
      parentList: parentList === null ? null : ARTIFACTS.requirementList.parse(parentList),
      parentTasks: parseSubtasks(await this.parentDocument(run, SUBTASKS_KIND)),
      taskId: run.taskId,
      subtask,
    });
    await ctx.write(ARTIFACTS.repos, ARTIFACTS.repos.parse(repos));
    const results = [
      { artifact: ARTIFACTS.impact, value: renderImpact(result.impact) },
      { artifact: ARTIFACTS.researchResult, value: result },
      ...(list && JSON.stringify(list) !== JSON.stringify(storedList)
        ? [{ artifact: ARTIFACTS.requirementList, value: list }]
        : []),
    ];
    const outcome = subtask
      ? await exchange.act(ctx, result, {
          step: this.name,
          route: 'document',
          answered: Boolean(answers.trim()),
          mayAsk: true,
          outputs: results,
          needsOutputs: [
            { artifact: ARTIFACTS.questions, value: '' },
            { artifact: ARTIFACTS.researchResult, value: result },
          ],
        })
      : null;
    if (outcome?.wait) {
      return outcome.wait;
    }
    if (subtask) await ctx.write(ARTIFACTS.needs, '');
    const questions = subtask ? '' : renderQuestions(result.questions);
    const paused = questions !== '';
    const assumed = outcome?.assumed.length ? assumptions(renderQuestions(outcome.assumed)) : '';
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
      outputs: [{ artifact: ARTIFACTS.questions, value: questions }, ...results],
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
