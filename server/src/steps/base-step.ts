import type { AppConfig } from '../config/env';
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
import type { OpenedStep } from '../steps/step-run';
import { closeStep, openStep } from '../steps/step-run';
import type { HttpCallDraft } from '../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../core/swarmloop-error';
import { recordHandoff } from './shared/handoff';
import type { Step } from './step';
import { requiredDocument, type StepSnapshot } from './step';

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
  calls: HttpCallDraft[];
  clock: Clock;
  end(input: StepEnd): Promise<PipelineResult>;
}

export abstract class BaseStep implements Step {
  abstract readonly name: StepName;
  abstract readonly requiredKind: string;
  readonly usesModel: boolean = false;

  constructor(
    protected readonly runs: RunRepository,
    protected readonly documents: DocumentRepository,
    protected readonly visits: VisitRepository,
    protected readonly flows: FlowRepository,
    protected readonly clock: Clock,
    protected readonly config: AppConfig,
  ) {}

  missingInput(key: string, _options?: StepOptions): Promise<string | null> {
    return requiredDocument(this.documents, key, this.requiredKind);
  }

  execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    return this.perform(key, (ctx) => this.run(key, options, ctx), snapshot);
  }

  /** Opens the step, runs its body, and closes the visit. A throw closes it as failed. */
  protected async perform(
    key: string,
    body: (ctx: StepContext) => Promise<PipelineResult>,
    snapshot?: StepSnapshot,
  ): Promise<PipelineResult> {
    const opened = await openStep(this.runs, this.clock, key, this.name);
    const calls: HttpCallDraft[] = [];
    let closed = false;
    const ctx: StepContext = {
      opened,
      calls,
      clock: this.clock,
      end: (input) => {
        closed = true;
        return this.close(opened, calls, input, snapshot);
      },
    };
    try {
      return await body(ctx);
    } catch (error) {
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
        visit: this.failureVisit(),
      });
    }
  }

  protected failureText(error: unknown): string {
    return error instanceof SwarmloopError ? error.message : `${this.name} failed`;
  }

  /** Merged into the visit of a failed run. A step overrides it to keep the failed visit it has always recorded. */
  protected failureVisit(): Partial<VisitDraft> {
    return {};
  }

  protected abstract run(key: string, options: StepOptions, ctx: StepContext): Promise<PipelineResult>;

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
