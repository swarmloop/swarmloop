import { mkdirSync } from 'fs';
import { join } from 'path';
import type { AppConfig, SwarmloopEnv } from '../config/env';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { FlowRepository } from '../history/flow.repository';
import { root } from '../history/run-paths';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { Clock } from '../core/clock';
import type { DocumentDraft } from '../history/visit';
import type { AgentProcessRunner, AgentRunResult } from '../agent/agent-runner';
import { readSession } from '../agent/agent-runner';
import { sessionFileName } from '../agent/session-group';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import { visitStatus } from '../core/pipeline-result';
import type { StepName } from '../contract/steps';
import type { OpenedStep } from '../pipeline/step-run';
import type { SandboxMount } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import { SwarmloopError } from '../core/swarmloop-error';
import type { StepContext } from './base-step';
import { BaseStep } from './base-step';
import { agentFailure, combineAgentResults, refusedWrite, withRefusal } from './shared/agent-result';
import { modelVisit } from './shared/model-visit';
import { AGENT_LANGUAGE_RULE } from './shared/skill-prompt';

export async function launchAgent(input: {
  agent: AgentProcessRunner;
  visits: VisitRepository;
  root: string;
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
  const directory = join(input.root, 'data');
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
    tokensInRun: await input.visits.tokenTotal(input.run.id),
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

/** Per-run state of one model step. It lives in one run call, not on the service, which is a singleton. */
interface ModelRun {
  key: string;
  opened: OpenedStep;
  settings: { mode: string; model: string; timeLimitMs: number };
  auto?: boolean;
  workspace: string;
  prompt: string;
  agentResult: AgentRunResult | null;
  launched: AgentRunResult[];
  /** The last refused write in any launch. Plan and ask keep going past it, so a parse error can name it. */
  refusal: string | null;
  /** The error launch threw for a kill or a bad exit. Its message already names the cause, so no refusal is added. */
  launchError: SwarmloopError | null;
}

export abstract class AgentStep extends BaseStep {
  override readonly usesModel = true;

  constructor(
    runs: RunRepository,
    documents: DocumentRepository,
    visits: VisitRepository,
    flows: FlowRepository,
    clock: Clock,
    config: AppConfig,
    protected readonly sandbox: SandboxService,
    protected readonly agent: AgentProcessRunner,
  ) {
    super(runs, documents, visits, flows, clock, config);
  }

  protected abstract settings(env: SwarmloopEnv): { mode: string; model: string; timeLimitMs: number };

  protected abstract write(key: string, ctx: ModelStepContext, options: StepOptions): Promise<PipelineResult>;

  /** The model body. The base step opens and closes the visit; this supplies the model visit through its context. */
  protected async run(key: string, options: StepOptions, stepCtx: StepContext): Promise<PipelineResult> {
    const env = this.config.env;
    const run: ModelRun = {
      key,
      opened: stepCtx.opened,
      settings: this.settings(env),
      auto: options.auto,
      workspace: join(root(this.config), 'worktrees', key),
      prompt: '',
      agentResult: null,
      launched: [],
      refusal: null,
      launchError: null,
    };
    const ctx: ModelStepContext = {
      opened: stepCtx.opened,
      requirements: '',
      workspace: run.workspace,
      end: (outcome, exitCode, line, document, documents, moveTo) =>
        stepCtx.end({
          outcome,
          exitCode,
          line,
          moveTo,
          visit: modelVisit({
            opened: run.opened,
            now: this.clock.now(),
            step: this.name,
            mode: run.settings.mode,
            model: run.settings.model,
            agent: run.agentResult,
            prompt: run.prompt,
            status: visitStatus(outcome),
            exitCode,
            document,
            documents,
          }),
        }),
      launch: (launch) => this.launch(run, launch),
    };
    try {
      await this.sandbox.assertReady(env.RUNTIME);
      const requirements = await this.documents.latestBody(key, 'requirements');
      if (!requirements) {
        throw new SwarmloopError('requirements is missing');
      }
      ctx.requirements = requirements;
      return await this.write(key, ctx, options);
    } catch (error) {
      const refusal = error === run.launchError ? null : run.refusal;
      return ctx.end('failed', 1, `${stepCtx.opened.startedAt} ${withRefusal(this.failureText(error), refusal)}`);
    }
  }

  private async launch(run: ModelRun, launch: Parameters<ModelStepContext['launch']>[0]): Promise<AgentRunResult> {
    const result = await launchAgent({
      agent: this.agent,
      visits: this.visits,
      root: root(this.config),
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
    run.refusal = refusedWrite(result.output) ?? run.refusal;
    const failed = agentFailure(result, this.name, run.settings.mode);
    if (failed) {
      run.launchError = new SwarmloopError(failed);
      throw run.launchError;
    }
    return result;
  }
}
