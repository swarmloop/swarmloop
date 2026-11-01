import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { readEnv, SwarmloopEnv } from '../config/env';
import { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { HistoryService } from '../history/history.service';
import { AgentProcessRunner, AgentRunResult } from '../limits/agent-runner';
import { PipelineResult, StepName, StepOptions, visitStatus } from '../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../pipeline/step-run';
import { SandboxService } from '../sandbox/sandbox.service';
import { SwarmloopError } from '../swarmloop-error';
import { modelVisit } from './model-visit';
import { agentFailure, combineAgentResults, launchAgent, ModelStepContext } from './model-step';
import { Step } from './step';

export interface AgentSettings {
  mode: string;
  model: string;
  timeLimitMs: number;
  runtime: RuntimeName;
  auto?: boolean;
}

/** Opens a model step, runs its body with an agent bound to the visit, and closes it. A throw closes it as failed. */
export abstract class AgentStep implements Step {
  abstract readonly name: StepName;
  readonly usesModel = true;

  constructor(
    protected readonly history: HistoryService,
    protected readonly config: ConfigService,
    protected readonly sandbox: SandboxService,
    protected readonly agent: AgentProcessRunner,
  ) {}

  abstract missingInput(key: string): Promise<string | null>;

  protected abstract settings(env: SwarmloopEnv, options: StepOptions): AgentSettings;

  protected abstract body(key: string, ctx: ModelStepContext, env: SwarmloopEnv, options: StepOptions): Promise<PipelineResult>;

  async execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const env = readEnv(this.config);
    const settings = this.settings(env, options);
    const opened = await openStep(this.history, key, this.name);
    let prompt = '';
    let agentResult: AgentRunResult | null = null;
    const launched: AgentRunResult[] = [];
    const end = this.bindModelStep({
      opened,
      mode: settings.mode,
      model: settings.model,
      agent: () => agentResult,
      prompt: () => prompt,
    });
    const ctx: ModelStepContext = {
      opened,
      requirements: '',
      workspace: join(this.history.root(), 'worktrees', key),
      end,
      launch: async (launch) => {
        const result = await launchAgent({
          agent: this.agent,
          history: this.history,
          run: opened.run,
          key,
          step: launch.label ? `${this.name}-${launch.label}` : this.name,
          liveStep: this.name,
          mode: settings.mode,
          model: settings.model,
          timeLimitMs: settings.timeLimitMs,
          auto: settings.auto,
          prompt: launch.prompt,
          workspace: ctx.workspace,
          mounts: launch.mounts,
          allowHosts: launch.allowHosts,
          resume: launch.resume,
          continuePrompt: launch.continuePrompt,
        });
        prompt = prompt ? `${prompt}\n\n${launch.prompt}` : launch.prompt;
        launched.push(result);
        agentResult = combineAgentResults(launched);
        const failed = agentFailure(result, this.name);
        if (failed) {
          throw new SwarmloopError(failed);
        }
        return result;
      },
    };
    try {
      await this.sandbox.assertReady(settings.runtime);
      const requirements = await this.history.latestBody(key, 'requirements');
      if (!requirements) {
        throw new SwarmloopError('requirements is missing');
      }
      ctx.requirements = requirements;
      return await this.body(key, ctx, env, options);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : `${this.name} failed`;
      return end('failed', 1, `${opened.startedAt} ${message}`);
    }
  }

  private bindModelStep(input: {
    opened: OpenedStep;
    mode: string;
    model: string;
    agent: () => AgentRunResult | null;
    prompt: () => string;
  }): ModelStepContext['end'] {
    return (outcome, exitCode, line, document, documents, moveTo) =>
      closeStep({
        history: this.history,
        run: input.opened.run,
        previousStep: input.opened.previousStep,
        previousStatus: input.opened.previousStatus,
        step: this.name,
        outcome,
        visit: modelVisit({
          opened: input.opened,
          step: this.name,
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
}
