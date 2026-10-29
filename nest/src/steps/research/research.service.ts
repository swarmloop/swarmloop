import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { readEnv } from '../../config/env';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentProcessRunner, AgentRunResult } from '../../limits/agent-runner';
import { PipelineResult, StepOptions } from '../../pipeline/pipeline-result';
import { SandboxMount } from '../../sandbox/sandbox-launch';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { renderProjects, storedProjects } from '../prepare/checkout-path';
import { plainSummary, recordHandoff, skillPrompt, summaryOr, textDocument, withHandoff, withModelStep, ModelStepContext } from '../model-step';
import { mountsForStep } from '../repo-names';
import { parseResearch } from './research-record';

@Injectable()
export class ResearchService {
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
        step: 'research',
        mode: 'plan',
        model: env.MODEL_PLAN,
        timeLimitMs: env.RESEARCH_TIMEOUT_MS,
        runtime: env.RUNTIME,
        auto: options.auto,
      },
      (ctx) => this.ask(ctx, options.auto),
    );
  }

  private async ask(ctx: ModelStepContext, auto?: boolean): Promise<PipelineResult> {
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
    const agentResult = await this.launch(ctx, full, mounts, auto);
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

  private async launch(ctx: ModelStepContext, full: string, mounts: SandboxMount[], auto?: boolean): Promise<AgentRunResult> {
    const maxCalls = readEnv(this.config).MAX_AGENT_CALLS;
    let prompt = full;
    let agentResult: AgentRunResult | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0 && auto && ctx.opened.run.agentCalls + 1 > maxCalls) {
        break;
      }
      agentResult = await ctx.launch({ prompt, mounts, returnTimeKill: true });
      if (agentResult.killReason !== 'time') {
        break;
      }
      prompt = agentResult.chatId ? RESEARCH_CONTINUE : full;
    }
    if (!agentResult || agentResult.killReason) {
      throw new SwarmloopError(`process killed: ${agentResult?.killReason ?? 'time'}`);
    }
    return agentResult;
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
