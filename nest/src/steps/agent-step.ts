import { mkdirSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { readEnv, SwarmloopEnv } from '../config/env';
import { RunEntity } from '../history/entities';
import { HistoryService } from '../history/history.service';
import { DocumentDraft } from '../history/visit';
import { AgentProcessRunner, AgentRunResult, readSession } from '../limits/agent-runner';
import { sessionFileName } from '../limits/session-group';
import { PipelineResult, StepName, StepOptions, visitStatus } from '../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../pipeline/step-run';
import { SandboxMount } from '../sandbox/sandbox-launch';
import { SandboxService } from '../sandbox/sandbox.service';
import { SwarmloopError } from '../swarmloop-error';
import { BaseStep } from './base-step';
import { agentFailure, combineAgentResults } from './shared/agent-result';
import { modelVisit } from './shared/model-visit';
import { AGENT_LANGUAGE_RULE } from './shared/skill-prompt';

function bindModelStep(input: {
  history: HistoryService;
  opened: OpenedStep;
  step: StepName;
  mode: string;
  model: string;
  agent: () => AgentRunResult | null;
  prompt: () => string;
}): (
  outcome: 'ok' | 'failed' | 'waiting' | 'blocked',
  exitCode: number,
  line: string,
  document?: DocumentDraft,
  documents?: DocumentDraft[],
  moveTo?: StepName,
) => Promise<PipelineResult> {
  return (outcome, exitCode, line, document, documents, moveTo) =>
    closeStep({
      history: input.history,
      run: input.opened.run,
      previousStep: input.opened.previousStep,
      previousStatus: input.opened.previousStatus,
      step: input.step,
      outcome,
      visit: modelVisit({
        opened: input.opened,
        step: input.step,
        mode: input.mode,
        model: input.model,
        agent: input.agent(),
        prompt: input.prompt(),
        status: visitStatus(outcome),
        exitCode,
        document,
        documents,
      }),
      line,
      exitCode,
      moveTo,
    });
}

export async function launchAgent(input: {
  agent: AgentProcessRunner;
  history: HistoryService;
  run: RunEntity;
  key: string;
  step: string;
  mode: string;
  model: string;
  timeLimitMs: number;
  prompt: string;
  workspace: string;
  mounts: SandboxMount[];
  liveStep?: string;
  allowHosts?: string[];
  approveMcps?: boolean;
  auto?: boolean;
  resume?: boolean;
  continuePrompt?: string | null;
}): Promise<AgentRunResult> {
  const directory = join(input.history.root(), 'data');
  mkdirSync(directory, { recursive: true });
  const sessionFile = join(directory, sessionFileName(input.key, input.step));
  const stored = await readSession(sessionFile, input.run.runtime);
  const result = await input.agent.run({
    prompt: `${AGENT_LANGUAGE_RULE}\n\n${input.prompt}`,
    workspace: input.workspace,
    outputFile: join(directory, `${input.key}-${input.step}-output.txt`),
    sessionFile,
    model: input.model,
    agentCalls: input.run.agentCalls,
    spentUsd: input.run.spentUsd,
    tokensInRun: await input.history.tokenTotal(input.run.id),
    resumeChatId: input.resume === false ? null : (stored?.chatId ?? null),
    groupUsd: input.resume === false ? 0 : (stored?.usd ?? 0),
    runKey: input.key,
    step: input.step,
    liveStep: input.liveStep,
    mounts: input.mounts,
    allowHosts: input.allowHosts,
    mode: input.mode,
    timeLimitMs: input.timeLimitMs,
    approveMcps: input.approveMcps,
    auto: input.auto,
    continuePrompt: input.continuePrompt,
  });
  input.run.agentCalls += result.calls;
  input.run.spentUsd += result.usd;
  return result;
}

export interface ModelStepContext {
  opened: OpenedStep;
  requirements: string;
  workspace: string;
  end: (
    outcome: 'ok' | 'failed' | 'waiting' | 'blocked',
    exitCode: number,
    line: string,
    document?: DocumentDraft,
    documents?: DocumentDraft[],
    moveTo?: StepName,
  ) => Promise<PipelineResult>;
  launch: (input: {
    prompt: string;
    mounts: SandboxMount[];
    allowHosts?: string[];
    label?: string;
    continuePrompt?: string;
    resume?: boolean;
  }) => Promise<AgentRunResult>;
}

/** Per-run state of one model step. It lives in one execute call, not on the service, which is a singleton. */
interface ModelRun {
  key: string;
  opened: OpenedStep;
  settings: { mode: string; model: string; timeLimitMs: number };
  auto?: boolean;
  workspace: string;
  prompt: string;
  agentResult: AgentRunResult | null;
  launched: AgentRunResult[];
}

export abstract class AgentStep extends BaseStep {
  readonly usesModel = true;

  constructor(
    history: HistoryService,
    protected readonly config: ConfigService,
    protected readonly sandbox: SandboxService,
    protected readonly agent: AgentProcessRunner,
  ) {
    super(history);
  }

  protected abstract settings(env: SwarmloopEnv): { mode: string; model: string; timeLimitMs: number };

  protected abstract write(key: string, ctx: ModelStepContext, options: StepOptions): Promise<PipelineResult>;

  async execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const env = readEnv(this.config);
    const opened = await openStep(this.history, key, this.name);
    const run: ModelRun = {
      key,
      opened,
      settings: this.settings(env),
      auto: options.auto,
      workspace: join(this.history.root(), 'worktrees', key),
      prompt: '',
      agentResult: null,
      launched: [],
    };
    const ctx: ModelStepContext = {
      opened,
      requirements: '',
      workspace: run.workspace,
      end: bindModelStep({
        history: this.history,
        opened,
        step: this.name,
        mode: run.settings.mode,
        model: run.settings.model,
        agent: () => run.agentResult,
        prompt: () => run.prompt,
      }),
      launch: (launch) => this.launch(run, launch),
    };
    try {
      await this.sandbox.assertReady(env.RUNTIME);
      const requirements = await this.history.latestBody(key, 'requirements');
      if (!requirements) {
        throw new SwarmloopError('requirements is missing');
      }
      ctx.requirements = requirements;
      return await this.write(key, ctx, options);
    } catch (error) {
      return ctx.end('failed', 1, `${opened.startedAt} ${this.failureText(error)}`);
    }
  }

  protected run(key: string, options: StepOptions): Promise<PipelineResult> {
    return this.execute(key, options);
  }

  private async launch(run: ModelRun, launch: Parameters<ModelStepContext['launch']>[0]): Promise<AgentRunResult> {
    const result = await launchAgent({
      agent: this.agent,
      history: this.history,
      run: run.opened.run,
      key: run.key,
      step: launch.label ? `${this.name}-${launch.label}` : this.name,
      liveStep: this.name,
      mode: run.settings.mode,
      model: run.settings.model,
      timeLimitMs: run.settings.timeLimitMs,
      auto: run.auto,
      prompt: launch.prompt,
      workspace: run.workspace,
      mounts: launch.mounts,
      allowHosts: launch.allowHosts,
      resume: launch.resume,
      continuePrompt: launch.continuePrompt,
    });
    run.prompt = run.prompt ? `${run.prompt}\n\n${launch.prompt}` : launch.prompt;
    run.launched.push(result);
    run.agentResult = combineAgentResults(run.launched);
    const failed = agentFailure(result, this.name);
    if (failed) {
      throw new SwarmloopError(failed);
    }
    return result;
  }
}
