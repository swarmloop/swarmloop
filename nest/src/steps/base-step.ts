import { HistoryService } from '../history/history.service';
import { sampleSelf, VisitDraft } from '../history/visit';
import { PipelineResult, StepName, StepOptions, visitStatus } from '../pipeline/pipeline-result';
import { closeStep, OpenedStep, openStep } from '../pipeline/step-run';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../swarmloop-error';
import { recordHandoff } from './model-step';
import { requiredDocument, Step } from './step';

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
  end(input: StepEnd): Promise<PipelineResult>;
}

/** Opens the step, runs its body, and closes the visit. A throw closes it as failed. */
export abstract class BaseStep implements Step {
  abstract readonly name: StepName;
  abstract readonly requiredKind: string;
  readonly usesModel = false;

  constructor(protected readonly history: HistoryService) {}

  missingInput(key: string): Promise<string | null> {
    return requiredDocument(this.history, key, this.requiredKind);
  }

  async execute(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const opened = await openStep(this.history, key, this.name);
    const calls: HttpCallDraft[] = [];
    let closed = false;
    const ctx: StepContext = {
      opened,
      calls,
      end: (input) => {
        closed = true;
        return this.close(opened, calls, input);
      },
    };
    try {
      return await this.run(key, options, ctx);
    } catch (error) {
      if (closed) {
        throw error;
      }
      if (error instanceof FetchFailed) {
        calls.push(...error.httpCalls);
      }
      return ctx.end({ outcome: 'failed', exitCode: 1, line: `${opened.startedAt} ${this.failureText(error)}` });
    }
  }

  protected failureText(error: unknown): string {
    return error instanceof SwarmloopError ? error.message : `${this.name} failed`;
  }

  protected abstract run(key: string, options: StepOptions, ctx: StepContext): Promise<PipelineResult>;

  private async close(opened: OpenedStep, calls: HttpCallDraft[], input: StepEnd): Promise<PipelineResult> {
    const visit: VisitDraft = {
      step: this.name,
      model: null,
      mode: null,
      startedAt: opened.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - opened.started,
      status: input.status ?? visitStatus(input.outcome),
      exitCode: input.exitCode,
      killReason: null,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      samples: [sampleSelf()],
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
