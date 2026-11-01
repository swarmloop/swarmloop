import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { SwarmloopEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentProcessRunner } from '../../limits/agent-runner';
import { PipelineResult, StepName, StepOptions } from '../../pipeline/pipeline-result';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { AgentSettings, AgentStep } from '../agent-step';
import { renderProjects, storedProjects } from '../prepare/checkout-path';
import { plainSummary, recordHandoff, skillPrompt, summaryOr, textDocument, withHandoff, ModelStepContext } from '../model-step';
import { mountsForStep } from '../repo-names';
import { parseResearch } from './research-record';

@Injectable()
export class ResearchService extends AgentStep {
  readonly name: StepName = 'research';

  constructor(
    history: HistoryService,
    config: ConfigService,
    sandbox: SandboxService,
    @Inject(AGENT_RUNNER) agent: AgentProcessRunner,
  ) {
    super(history, config, sandbox, agent);
  }

  async missingInput(key: string): Promise<string | null> {
    return existsSync(join(this.history.root(), 'worktrees', key)) ? null : `worktrees/${key}`;
  }

  protected settings(env: SwarmloopEnv, options: StepOptions): AgentSettings {
    return { mode: 'plan', model: env.MODEL_PLAN, timeLimitMs: env.RESEARCH_TIMEOUT_MS, runtime: env.RUNTIME, auto: options.auto };
  }

  protected async body(_key: string, ctx: ModelStepContext): Promise<PipelineResult> {
    const stored = storedProjects(ctx.opened.run.projects);
    const names = stored.length > 0 ? stored : listWorktrees(ctx.workspace);
    if (names.length === 0) {
      throw new SwarmloopError('worktrees is empty');
    }
    const answers = (await this.history.latestBody(ctx.opened.run.key, 'answers')) ?? '';
    const prior = await this.history.latestBody(ctx.opened.run.key, 'handoff');
    const sections = withHandoff(answers.trim() ? [{ heading: 'Answers', body: answers }] : [], prior);
    const mounts = mountsForStep(this.history.root(), ctx.opened.run.key, names, null);
    const full = skillPrompt('research', ctx.requirements, names, sections, mounts);
    const agentResult = await ctx.launch({ prompt: full, mounts, continuePrompt: RESEARCH_CONTINUE });
    const parsed = parseResearch(agentResult.responseText);
    const repos = renderProjects(names);
    const paused = parsed.questions !== '';
    await this.history.putDocument(ctx.opened.run, 'repos', repos);
    const detail = (paused ? parsed.questions : repos).trimEnd();
    const word = paused ? 'waiting' : 'done';
    const summary = summaryOr(agentResult.responseText, plainSummary(agentResult.responseText) || `- chose ${repos.trim().split('\n').join(', ')}`);
    const handoff = await recordHandoff(this.history, ctx.opened.run.key, 'research', summary);
    return ctx.end(
      paused ? 'waiting' : 'ok',
      0,
      `${ctx.opened.startedAt} research ${word}\n${detail}`,
      textDocument('questions', parsed.questions),
      [handoff],
    );
  }
}

const RESEARCH_CONTINUE = [
  'You were interrupted before the summary. Finish this research. Do not start over.',
  'End with these sections:',
  'summary:',
  '- why',
  '',
  'questions:',
  '- none',
].join('\n');

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
