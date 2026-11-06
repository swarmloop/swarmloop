import type { AppConfig, SwarmloopEnv } from '../config/env';
import type { DocumentRepository } from '../history/document.repository';
import type { FlowRepository } from '../history/flow.repository';
import { root } from '../history/run-paths';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { VisitDraft } from '../history/visit';
import { sampleSelf } from '../history/visit';
import type { Clock } from '../core/clock';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import { visitStatus } from '../core/pipeline-result';
import type { StepName } from '../contract/steps';
import type { RunEntity } from '../history/entities';
import type { OpenedStep } from '../steps/step-run';
import { closeStep, openStep } from '../steps/step-run';
import type { HttpCallDraft } from '../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../core/swarmloop-error';
import { recordHandoff } from './shared/handoff';
import type { Artifact } from './contract/artifact';
import { InputReader } from './contract/input-reader';
import { outputDrafts } from './contract/output-writer';
import { routeToEnd } from './contract/route';
import { assertRoute } from './contract/returns';
import type { InputSpec, StepCapabilities, StepDescriptor, StepInput, StepResult } from './contract/step-contract';
import type { Step } from './step';
import type { StepSnapshot } from './step';
import type { StepKernel } from './step-kernel';

export interface StepEnd {
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting';
  exitCode: number;
  line: string;
  status?: string;
  moveTo?: StepName;
  /** Body of this step's handoff section. Recorded inside the close, so a failure there is not a failed visit. */
  handoff?: string;
  visit?: Partial<VisitDraft>;
}

export interface StepContext {
  opened: OpenedStep;
  options: StepOptions;
  calls: HttpCallDraft[];
  clock: Clock;
  /** The latest stored value of a kind, read through the input reader. Null when nothing is stored. */
  reread<T>(artifact: Artifact<T>): Promise<T | null>;
  /** Stores a document outside the visit, such as progress a later pass resumes from. */
  write<T>(artifact: Artifact<T>, value: T): Promise<void>;
  end(input: StepEnd): Promise<PipelineResult>;
}

/** Thrown by a body that has left the visit open, to return its own result without closing it. */
export class VisitLeftOpen extends Error {
  constructor(readonly result: PipelineResult) {
    super(result.message);
  }
}

/** What every step shares: the kernel services, and opening and closing a visit. */
abstract class StepCore implements Step {
  abstract readonly name: StepName;
  readonly usesModel: boolean = false;
  readonly capabilities: StepCapabilities = {};
  protected readonly reader: InputReader;

  constructor(protected readonly kernel: StepKernel) {
    this.reader = new InputReader(kernel.documents);
  }

  protected get runs(): RunRepository {
    return this.kernel.runs;
  }

  protected get documents(): DocumentRepository {
    return this.kernel.documents;
  }

  protected get visits(): VisitRepository {
    return this.kernel.visits;
  }

  protected get flows(): FlowRepository {
    return this.kernel.flows;
  }

  protected get clock(): Clock {
    return this.kernel.clock;
  }

  protected get config(): AppConfig {
    return this.kernel.config;
  }

  describe(_env: SwarmloopEnv): StepDescriptor {
    return {
      name: this.name,
      kind: this.usesModel ? 'agent' : 'server',
      inputs: [],
      outputs: [],
      capabilities: this.capabilities,
    };
  }

  abstract missingInput(key: string, options?: StepOptions): Promise<string | null>;

  abstract execute(key: string, options?: StepOptions, snapshot?: StepSnapshot): Promise<PipelineResult>;

  /** Opens the step, runs its body, and closes the visit. A throw closes it as failed. */
  protected async perform(
    key: string,
    body: (ctx: StepContext) => Promise<PipelineResult>,
    snapshot?: StepSnapshot,
    options: StepOptions = {},
  ): Promise<PipelineResult> {
    const opened = await openStep(this.runs, this.clock, key, this.name);
    const calls: HttpCallDraft[] = [];
    let closed = false;
    const ctx: StepContext = {
      opened,
      options,
      calls,
      clock: this.clock,
      reread: (artifact) => this.reader.reread(key, artifact),
      write: (artifact, value) => this.store(opened.run, artifact, value),
      end: (input) => {
        closed = true;
        return this.close(opened, calls, input, snapshot);
      },
    };
    try {
      return await body(ctx);
    } catch (error) {
      if (error instanceof VisitLeftOpen) {
        return error.result;
      }
      if (closed) {
        throw error;
      }
      if (error instanceof FetchFailed) {
        calls.push(...error.httpCalls);
      }
      return ctx.end({
        outcome: 'failed',
        exitCode: 1,
        line: `${opened.startedAt} ${this.failureText(error)}`,
        visit: this.failureVisit(opened),
      });
    }
  }

  /** Stores a document of the run outside any visit. */
  protected store<T>(run: RunEntity, artifact: Artifact<T>, value: T): Promise<void> {
    return this.documents.putDocument(run, artifact.kind, artifact.format(value));
  }

  protected failureText(error: unknown): string {
    return error instanceof SwarmloopError ? error.message : `${this.name} failed`;
  }

  /** Merged into the visit of a failed run. A step overrides it to keep the failed visit it has always recorded. */
  protected failureVisit(_opened: OpenedStep): Partial<VisitDraft> {
    return {};
  }

  private async close(
    opened: OpenedStep,
    calls: HttpCallDraft[],
    input: StepEnd,
    snapshot?: StepSnapshot,
  ): Promise<PipelineResult> {
    const finishedAt = this.clock.iso();
    const visit: VisitDraft = {
      step: this.name,
      model: null,
      mode: null,
      startedAt: opened.startedAt,
      finishedAt,
      durationMs: this.clock.now() - opened.started,
      status: input.status ?? visitStatus(input.outcome),
      exitCode: input.exitCode,
      killReason: null,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      samples: [sampleSelf(finishedAt)],
      exchange: null,
      httpCalls: calls,
      document: null,
      resumed: false,
      ...input.visit,
    };
    if (input.handoff !== undefined) {
      const handoff = await recordHandoff(this.documents, opened.run.key, this.name, input.handoff);
      visit.documents = [...(visit.documents ?? []), handoff];
    }
    const result = await closeStep({
      runs: this.runs,
      visits: this.visits,
      flows: this.flows,
      root: root(this.config),
      clock: this.clock,
      run: opened.run,
      previousStep: opened.previousStep,
      previousStatus: opened.previousStatus,
      step: this.name,
      outcome: input.outcome,
      exitCode: input.exitCode,
      line: input.line,
      moveTo: input.moveTo,
      visit,
    });
    await snapshot?.(opened.run, this.name);
    return result;
  }
}

/** A step on the declared contract: it states its inputs and outputs, and `work` turns the inputs into a result. */
export abstract class BaseStep<S extends InputSpec = InputSpec> extends StepCore {
  abstract readonly inputs: S;
  abstract readonly outputs: Artifact<unknown>[];

  override describe(env: SwarmloopEnv): StepDescriptor {
    return {
      ...super.describe(env),
      inputs: Object.entries(this.inputs).map(([name, entry]) => ({
        name,
        kind: entry.artifact.kind,
        need: entry.need,
      })),
      outputs: this.outputs.map((output) => output.kind),
    };
  }

  missingInput(key: string, _options?: StepOptions): Promise<string | null> {
    return this.reader.missing(key, this.inputs, 'start');
  }

  execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    return this.perform(
      key,
      async (ctx) => {
        await this.ready(ctx);
        return this.conclude(ctx, await this.work(await this.reader.read(key, this.inputs), ctx));
      },
      snapshot,
      options,
    );
  }

  /** Runs before the inputs are read. A step overrides it to check what it needs from the machine. */
  protected ready(_ctx: StepContext): Promise<void> {
    return Promise.resolve();
  }

  /** Ends the visit as the route of the result says: its outputs first, then the handoff. */
  protected async conclude(ctx: StepContext, result: StepResult): Promise<PipelineResult> {
    assertRoute(this.name, result.route);
    const documents = outputDrafts(this.name, this.outputs, result.outputs);
    if (result.handoff !== undefined) {
      documents.push(await recordHandoff(this.documents, ctx.opened.run.key, this.name, result.handoff));
    }
    const ended = await ctx.end({
      ...routeToEnd(result.route, result.exitCode),
      line: result.summary,
      visit: { ...result.visit, ...(documents.length > 0 ? { documents } : {}) },
    });
    return result.afterClose ? result.afterClose(ended) : ended;
  }

  protected abstract work(input: StepInput<S>, ctx: StepContext): Promise<StepResult>;
}
