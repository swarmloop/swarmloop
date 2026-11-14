import { join } from 'path';
import type { SwarmloopEnv } from '../config/env';
import { root } from '../history/run-paths';
import type { RunEntity } from '../history/entities';
import { effortFields } from '../contract/effort';
import { CONTRACT_KIND } from '../contract/subtask';
import type { SampleDraft, VisitDraft } from '../history/visit';
import type { AgentRunResult } from '../agent/agent-runner';
import { visitStatus } from '../core/pipeline-result';
import type { StepOptions } from '../core/pipeline-result';
import type { OpenedStep } from '../steps/step-run';
import type { SandboxService } from '../sandbox/sandbox.service';
import { GitAuthError, RuntimeLimit, SwarmloopError } from '../core/swarmloop-error';
import type { StepKernel } from './step-kernel';
import { BaseStep } from './base-step';
import type { StepContext } from './base-step';
import { outputDrafts } from './contract/output-writer';
import { routeToEnd } from './contract/route';
import type { AgentProfile, InputSpec, StepDescriptor, StepInput, StepResult } from './contract/step-contract';
import { ERROR_CODES } from '../contract/error-codes';
import type { ErrorCode } from '../contract/error-codes';
import { waitingEnd } from './step-error-end';
import { agentFailure, combineAgentResults, refusedWrite, withRefusal } from './shared/agent-result';
import type { AgentLauncher } from './shared/agent-launcher';
import { limitRoute } from './shared/limit-failover';
import { recordHandoff } from './shared/handoff';
import { modelVisit } from './shared/model-visit';
import type { StepName } from '../contract/steps';
import { artifact, firstLine } from './contract/artifact';
import type { Artifact } from './contract/artifact';
import { ARTIFACTS, INSTRUCTIONS } from './contract/artifacts';
import { ResultInvalid } from './shared/answer-errors';
import type { ModelStepContext } from './model-step-context';
import { answerErrorsDocument } from './shared/stored-answer-errors';
import type { LaunchResult } from './shared/result-exchange';

export type { ModelStepContext } from './model-step-context';

/** The requirements, which no agent step starts without. Every agent step declares it first. */
export const REQUIREMENTS_INPUT = { artifact: ARTIFACTS.requirements, need: 'run' } as const;

/** A kind the step loads itself, at the point it needs it. */
export function lateInput<T>(artifact: Artifact<T>): { artifact: Artifact<T>; need: 'optional'; late: true } {
  return { artifact, need: 'optional', late: true } as const;
}

/** The instructions a person gave this step. */
export function instructionsInput(step: StepName): { artifact: Artifact; need: 'optional'; late: true } {
  return lateInput(
    artifact(INSTRUCTIONS.of(step), { writers: [], readers: [step], external: true, summarize: firstLine }),
  );
}

/** Per-run state of one model step. It lives in one run call, not on the service, which is a singleton. */
interface ModelRun {
  key: string;
  opened: OpenedStep;
  profile: AgentProfile;
  auto?: boolean;
  /** The errors of the answer the step's last visit failed on, told to the agent on the first launch. */
  answerErrors?: string[];
  workspace: string;
  prompt: string;
  agentResult: AgentRunResult | null;
  launched: AgentRunResult[];
  /** Samples of containers the step started besides the agent's, such as a project setup. */
  samples: SampleDraft[];
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

  /** The `contract` the parent run holds right now, read when the step runs. Null for a run without a parent. */
  protected async parentContract(run: RunEntity): Promise<string | null> {
    const parentId = run.parentRunId;
    const parent = typeof parentId === 'number' ? await this.runs.findById(parentId) : null;
    return parent ? this.documents.latestBody(parent.key, CONTRACT_KIND) : null;
  }

  /** The runtime, model, mode, time limit and session policy of this step, known before it runs. */
  protected abstract profile(env: SwarmloopEnv, run?: RunEntity | null): AgentProfile;

  /**
   * The model body. Its documents are `outputs`, then the `handoff`, then the ones in `visit.documents`;
   * the agent log is appended after them.
   */
  protected abstract produce(input: StepInput<S>, ctx: ModelStepContext, options: StepOptions): Promise<StepResult>;

  protected override agentProfile(): AgentProfile {
    return this.profile(this.config.env);
  }

  protected override ready(): Promise<void> {
    return this.sandbox.assertReady(this.profile(this.config.env).runtime);
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
      profile: this.profile(env, opened.run),
      auto: options.auto,
      answerErrors: options.answerErrors,
      workspace: join(root(this.config), 'worktrees', opened.run.key),
      prompt: '',
      agentResult: null,
      launched: [],
      samples: [],
      refusal: null,
      launchError: null,
    };
    const ctx: ModelStepContext = {
      opened,
      workspace: run.workspace,
      samples: run.samples,
      reread: (artifact) => stepCtx.reread(artifact),
      write: (artifact, value) => stepCtx.write(artifact, value),
      activity: (title, fn, result) => stepCtx.activity(title, fn, result),
      launch: (launch) => this.launch(run, launch),
    };
    try {
      return await this.finish(run, await this.produce(input, ctx, options));
    } catch (error) {
      if (error instanceof RuntimeLimit) {
        return this.limited(run, error);
      }
      if (error instanceof GitAuthError) {
        return {
          route: { to: 'wait', reason: error.message, code: error.code },
          summary: `${run.opened.startedAt} ${error.message}`,
          outputs: [],
          visit: this.modelVisitOf(run, 'waiting', 0),
        };
      }
      const waiting = waitingEnd(error, this.clock, this.config.env);
      if (waiting) {
        return {
          route: { to: 'wait', reason: waiting.message, code: waiting.code as ErrorCode, retryAt: waiting.retryAt },
          summary: `${run.opened.startedAt} ${waiting.message}`,
          outputs: [],
          visit: this.modelVisitOf(run, 'waiting', 0),
        };
      }
      const refusal = error === run.launchError ? null : run.refusal;
      const failure = this.failureOf(error);
      return {
        route: { to: 'fail', error: failure },
        summary: `${opened.startedAt} ${withRefusal(failure.message, refusal)}`,
        outputs: [],
        visit: this.modelVisitOf(
          run,
          'failed',
          1,
          failure.answerErrors && [answerErrorsDocument(failure.answerErrors)],
        ),
      };
    }
  }

  /** Every agent of the role is limited: the step waits, and the run goes on by itself when one is free again. */
  private limited(run: ModelRun, error: RuntimeLimit): StepResult {
    return {
      route: limitRoute(error),
      summary: `${run.opened.startedAt} ${error.message}`,
      outputs: [],
      visit: this.modelVisitOf(run, 'waiting', 0),
    };
  }

  /** Before `work` ran, the visit still names the model and mode, with no samples. */
  protected override failureVisit(opened: OpenedStep): Partial<VisitDraft> {
    const { mode, runtime, model, effort, effortNote } = this.profile(this.config.env, opened.run);
    return modelVisit({
      opened,
      now: this.clock.now(),
      step: this.name,
      mode,
      runtime,
      model,
      ...effortFields({ effort, effortNote }),
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
      runtime: run.profile.runtime,
      model: run.profile.model,
      ...effortFields(run.profile),
      agent: run.agentResult,
      samples: run.samples,
      prompt: run.prompt,
      status,
      exitCode,
      documents,
    });
  }

  private async launch(run: ModelRun, launch: Parameters<ModelStepContext['launch']>[0]): Promise<LaunchResult> {
    const instructions =
      launch.resume === false ? null : await this.documents.latestBody(run.key, INSTRUCTIONS.of(this.name));
    const withInstructions = (text: string): string =>
      instructions?.trim() ? `${text}\n\nLatest user instructions:\n${instructions}` : text;
    const prompt = withInstructions(launch.prompt);
    // Only the first launch of the visit is told: later launches of the step are other chats.
    const answerErrors = run.answerErrors;
    run.answerErrors = undefined;
    const result = await this.launcher
      .launch({
        root: root(this.config),
        run: run.opened.run,
        key: run.key,
        step: launch.label ? `${this.name}-${launch.label}` : this.name,
        liveStep: this.name,
        mode: run.profile.mode,
        tools: run.profile.tools,
        runtime: run.profile.runtime,
        model: run.profile.model,
        ...effortFields(run.profile),
        timeLimitMs: run.profile.timeLimitMs,
        auto: run.auto,
        prompt,
        workspace: run.workspace,
        mounts: launch.mounts,
        allowHosts: launch.allowHosts,
        manifestHosts: launch.manifestHosts,
        resume: launch.resume,
        continuePrompt: launch.continuePrompt,
        freshPrompt: launch.freshPrompt === undefined ? undefined : withInstructions(launch.freshPrompt),
        failover: true,
        brief: launch.freshPrompt === undefined ? prompt : withInstructions(launch.freshPrompt),
        briefFor: launch.briefFor && ((runtime) => withInstructions(launch.briefFor?.(runtime) ?? prompt)),
        result: launch.result,
        check: launch.check,
        answerErrors,
        project: launch.project,
        projectFor: launch.projectFor,
      })
      .catch((error: unknown) => {
        if (error instanceof ResultInvalid) run.refusal = refusedWrite(error.output) ?? run.refusal;
        throw error;
      });
    if (result.agent) {
      // The step goes on with the agent that took over, and its visit records that agent.
      const { effort: _effort, effortNote: _effortNote, ...profile } = run.profile;
      run.profile = { ...profile, ...result.agent };
    }
    run.prompt = run.prompt ? `${run.prompt}\n\n${prompt}` : prompt;
    run.launched.push(result);
    run.agentResult = combineAgentResults(run.launched);
    run.refusal = refusedWrite(result.output) ?? run.refusal;
    const failed = agentFailure(result, this.name, run.profile.mode);
    if (failed) {
      run.launchError = new SwarmloopError(
        failed,
        result.killReason === 'loop' ? { code: ERROR_CODES.AGENT_LOOPING, category: 'model' } : undefined,
      );
      throw run.launchError;
    }
    if (result.backgroundKilled) {
      run.launchError = new SwarmloopError(
        `${this.name} failed: the agent ended its turn with background work still running`,
        { code: ERROR_CODES.AGENT_ENDED_EARLY, category: 'model' },
      );
      throw run.launchError;
    }
    return result;
  }
}
