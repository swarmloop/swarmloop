import { join } from 'path';
import type { SwarmloopEnv } from '../config/env';
import { root } from '../history/run-paths';
import type { VisitDraft } from '../history/visit';
import type { AgentRunResult } from '../agent/agent-runner';
import { visitStatus } from '../core/pipeline-result';
import type { StepOptions } from '../core/pipeline-result';
import type { OpenedStep } from '../steps/step-run';
import type { SandboxMount } from '../core/sandbox-mount';
import type { ProjectLaunch } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';
import { SwarmloopError } from '../core/swarmloop-error';
import type { StepKernel } from './step-kernel';
import { BaseStep } from './base-step';
import type { StepContext } from './base-step';
import { outputDrafts } from './contract/output-writer';
import { routeToEnd } from './contract/route';
import type { AgentProfile, InputSpec, StepDescriptor, StepInput, StepResult } from './contract/step-contract';
import { agentFailure, combineAgentResults, refusedWrite, withRefusal } from './shared/agent-result';
import type { AgentLauncher } from './shared/agent-launcher';
import { recordHandoff } from './shared/handoff';
import { modelVisit } from './shared/model-visit';
import type { StepName } from '../contract/steps';
import { artifact } from './contract/artifact';
import type { Artifact } from './contract/artifact';
import { ARTIFACTS, INSTRUCTIONS } from './contract/artifacts';

/** The requirements, which no agent step starts without. Every agent step declares it first. */
export const REQUIREMENTS_INPUT = { artifact: ARTIFACTS.requirements, need: 'run' } as const;

/** A kind the step loads itself, at the point it needs it. */
export function lateInput<T>(artifact: Artifact<T>): { artifact: Artifact<T>; need: 'optional'; late: true } {
  return { artifact, need: 'optional', late: true } as const;
}

/** The instructions a person gave this step. */
export function instructionsInput(step: StepName): { artifact: Artifact; need: 'optional'; late: true } {
  return lateInput(artifact(INSTRUCTIONS.of(step), { writers: [], readers: [step], external: true }));
}

export interface ModelStepContext {
  opened: OpenedStep;
  workspace: string;
  reread: StepContext['reread'];
  write: StepContext['write'];
  launch: (input: {
    prompt: string;
    mounts: SandboxMount[];
    allowHosts?: string[];
    label?: string;
    continuePrompt?: string;
    resume?: boolean;
    project?: ProjectLaunch;
  }) => Promise<AgentRunResult>;
}

/** Per-run state of one model step. It lives in one run call, not on the service, which is a singleton. */
interface ModelRun {
  key: string;
  opened: OpenedStep;
  profile: AgentProfile;
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

export abstract class AgentStep<S extends InputSpec = InputSpec> extends BaseStep<S> {
  override readonly usesModel = true;

  constructor(
    kernel: StepKernel,
    protected readonly sandbox: SandboxService,
    private readonly launcher: AgentLauncher,
  ) {
    super(kernel);
  }

  /** The runtime, model, mode, time limit and session policy of this step, known before it runs. */
  protected abstract profile(env: SwarmloopEnv): AgentProfile;

  /**
   * The model body. Its documents are `outputs`, then the `handoff`, then the ones in `visit.documents`;
   * the agent log is appended after them.
   */
  protected abstract produce(input: StepInput<S>, ctx: ModelStepContext, options: StepOptions): Promise<StepResult>;

  protected override ready(): Promise<void> {
    return this.sandbox.assertReady(this.config.env.RUNTIME);
  }

  override describe(env: SwarmloopEnv): StepDescriptor {
    return { ...super.describe(env), agent: this.profile(env) };
  }

  protected async work(input: StepInput<S>, stepCtx: StepContext): Promise<StepResult> {
    const env = this.config.env;
    const { opened, options } = stepCtx;
    // The reader only rejects an absent document. A blank one is as unusable as none.
    if (!(input as { requirements: string }).requirements) {
      throw new SwarmloopError('requirements is missing');
    }
    const run: ModelRun = {
      key: opened.run.key,
      opened,
      profile: this.profile(env),
      auto: options.auto,
      workspace: join(root(this.config), 'worktrees', opened.run.key),
      prompt: '',
      agentResult: null,
      launched: [],
      refusal: null,
      launchError: null,
    };
    const ctx: ModelStepContext = {
      opened,
      workspace: run.workspace,
      reread: (artifact) => stepCtx.reread(artifact),
      write: (artifact, value) => stepCtx.write(artifact, value),
      launch: (launch) => this.launch(run, launch),
    };
    try {
      return await this.finish(run, await this.produce(input, ctx, options));
    } catch (error) {
      const refusal = error === run.launchError ? null : run.refusal;
      const failure = this.failureOf(error);
      return {
        route: { to: 'fail', error: failure },
        summary: `${opened.startedAt} ${withRefusal(failure.message, refusal)}`,
        outputs: [],
        visit: this.modelVisitOf(run, 'failed', 1),
      };
    }
  }

  /** Before `work` ran, the visit still names the model and mode, with no samples. */
  protected override failureVisit(opened: OpenedStep): Partial<VisitDraft> {
    const { mode, model } = this.profile(this.config.env);
    return modelVisit({
      opened,
      now: this.clock.now(),
      step: this.name,
      mode,
      model,
      agent: null,
      prompt: '',
      status: 'failed',
      exitCode: 1,
    });
  }

  /** Builds the model visit of a finished body, with its documents in order. The base step then closes it. */
  private async finish(run: ModelRun, result: StepResult): Promise<StepResult> {
    const { outcome, exitCode } = routeToEnd(result.route, result.exitCode);
    const documents = outputDrafts(this.name, this.outputs, result.outputs);
    if (result.handoff !== undefined) {
      documents.push(await recordHandoff(this.documents, run.key, this.name, result.handoff));
    }
    documents.push(...(result.visit?.documents ?? []));
    return {
      route: result.route,
      summary: result.summary,
      exitCode: result.exitCode,
      outputs: [],
      visit: this.modelVisitOf(run, visitStatus(outcome), exitCode, documents),
    };
  }

  private modelVisitOf(
    run: ModelRun,
    status: string,
    exitCode: number,
    documents?: NonNullable<VisitDraft['documents']>,
  ): VisitDraft {
    return modelVisit({
      opened: run.opened,
      now: this.clock.now(),
      step: this.name,
      mode: run.profile.mode,
      model: run.profile.model,
      agent: run.agentResult,
      prompt: run.prompt,
      status,
      exitCode,
      documents,
    });
  }

  private async launch(run: ModelRun, launch: Parameters<ModelStepContext['launch']>[0]): Promise<AgentRunResult> {
    const instructions =
      launch.resume === false ? null : await this.documents.latestBody(run.key, INSTRUCTIONS.of(this.name));
    const prompt = instructions?.trim()
      ? `${launch.prompt}\n\nLatest user instructions:\n${instructions}`
      : launch.prompt;
    const result = await this.launcher.launch({
      root: root(this.config),
      run: run.opened.run,
      key: run.key,
      step: launch.label ? `${this.name}-${launch.label}` : this.name,
      liveStep: this.name,
      mode: run.profile.mode,
      model: run.profile.model,
      timeLimitMs: run.profile.timeLimitMs,
      auto: run.auto,
      prompt,
      workspace: run.workspace,
      mounts: launch.mounts,
      allowHosts: launch.allowHosts,
      resume: launch.resume,
      continuePrompt: launch.continuePrompt,
      project: launch.project,
    });
    run.prompt = run.prompt ? `${run.prompt}\n\n${prompt}` : prompt;
    run.launched.push(result);
    run.agentResult = combineAgentResults(run.launched);
    run.refusal = refusedWrite(result.output) ?? run.refusal;
    const failed = agentFailure(result, this.name, run.profile.mode);
    if (failed) {
      run.launchError = new SwarmloopError(failed);
      throw run.launchError;
    }
    return result;
  }
}
