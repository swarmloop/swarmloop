import type { HistoryService } from '../history/history.service';
import type { VisitDraft } from '../history/visit';
import { sampleSelf } from '../history/visit';
import type { Clock } from '../core/clock';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import { visitStatus } from '../core/pipeline-result';
import type { StepName } from '../contract/steps';
import type { OpenedStep } from '../pipeline/step-run';
import { closeStep, openStep } from '../pipeline/step-run';
import type { HttpCallDraft } from '../core/swarmloop-error';
import { FetchFailed, SwarmloopError } from '../core/swarmloop-error';
import { recordHandoff } from './shared/handoff';
import type { Step } from './step';
import { requiredDocument } from './step';

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
    protected readonly history: HistoryService,
    protected readonly clock: Clock,
  ) {}

  missingInput(key: string, _options?: StepOptions): Promise<string | null> {
    return requiredDocument(this.history, key, this.requiredKind);
  }

  execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    return this.perform(key, (ctx) => this.run(key, options, ctx));
  }

  /** Opens the step, runs its body, and closes the visit. A throw closes it as failed. */
  protected async perform(key: string, body: (ctx: StepContext) => Promise<PipelineResult>): Promise<PipelineResult> {
    const opened = await openStep(this.history, this.clock, key, this.name);
    const calls: HttpCallDraft[] = [];
    let closed = false;
    const ctx: StepContext = {
      opened,
      calls,
      clock: this.clock,
      end: (input) => {
        closed = true;
        return this.close(opened, calls, input);
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

  private async close(opened: OpenedStep, calls: HttpCallDraft[], input: StepEnd): Promise<PipelineResult> {
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
      const handoff = await recordHandoff(this.history, opened.run.key, this.name, input.handoff);
      visit.documents = [...(visit.documents ?? []), handoff];
    }
    return closeStep({
      history: this.history,
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
  }
}
