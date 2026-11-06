import { DataSource } from 'typeorm';
import { StepKernel } from '../steps/step-kernel';
import type { StepName } from '../contract/steps';
import { STEPS } from '../contract/steps';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import { DocumentRepository } from '../history/document.repository';
import { StepEventLog } from '../history/step-event.log';
import { FlowRepository } from '../history/flow.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { BaseStep, type StepContext, type StepEnd } from '../steps/base-step';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { InputSpec } from '../steps/contract/step-contract';
import { StepRegistry } from '../steps/step.registry';
import type { Step, StepSnapshot } from '../steps/step';
import { createTestApp } from '../testing/test-app';
import {
  expectGolden,
  recordingDocuments,
  traceRun,
  type RecordingDocuments,
} from '../testing/step-trace.spec-helpers';
import { PipelineService } from './pipeline.service';

const KEY = 'PROJ-1';

type Script = (visit: number, ctx: StepContext) => Omit<StepEnd, 'line'>;

const INPUTS = { requirements: { artifact: ARTIFACTS.requirements, need: 'start' } } as const satisfies InputSpec;

/** Ends each visit as its script says, through the step context. */
class DriverStep extends BaseStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly outputs = [];
  count = 0;

  constructor(
    readonly name: StepName,
    readonly recorder: RecordingDocuments,
    base: {
      runs: RunRepository;
      visits: VisitRepository;
      flows: FlowRepository;
      clock: Clock;
      config: AppConfig;
      stepEvents: StepEventLog;
    },
    private readonly script: Script,
  ) {
    super(new StepKernel(base.runs, recorder, base.visits, base.flows, base.clock, base.config, base.stepEvents));
  }

  override execute(key: string, options: StepOptions = {}, snapshot?: StepSnapshot): Promise<PipelineResult> {
    return this.perform(
      key,
      async (ctx) => {
        await this.reader.read(key, this.inputs);
        this.count += 1;
        const end = this.script(this.count, ctx);
        return ctx.end({ ...end, line: `${ctx.opened.startedAt} ${this.name} ${end.outcome}` });
      },
      snapshot,
      options,
    );
  }

  protected work(): never {
    throw new Error('DriverStep ends its visits in execute');
  }
}

const ok: Script = () => ({ outcome: 'ok', exitCode: 0 });

async function drive(scripts: Partial<Record<StepName, Script>>, options: StepOptions, key = KEY) {
  const app = await createTestApp();
  try {
    const base = {
      runs: app.app.get(RunRepository),
      visits: app.app.get(VisitRepository),
      flows: app.app.get(FlowRepository),
      clock: app.app.get(Clock),
      config: app.app.get(AppConfig),
      stepEvents: app.app.get(StepEventLog),
    };
    const documents = app.app.get(DocumentRepository);
    const steps = new Map<StepName, DriverStep>();
    for (const name of STEPS) {
      if (name === 'done') continue;
      steps.set(name, new DriverStep(name, recordingDocuments(documents), base, scripts[name] ?? ok));
    }
    const registry = app.app.get<{ get(name: StepName): Step | null }>(StepRegistry);
    registry.get = (name) => steps.get(name) ?? null;
    const result = await app.app.get(PipelineService).runThrough(key, options);
    const reads = Object.fromEntries([...steps].map(([name, step]) => [name, step.recorder.kinds]));
    return { result, trace: { result, ...(await traceRun(app.app.get(DataSource), key, reads)) } };
  } finally {
    await app.close();
  }
}

describe('run driver golden traces', () => {
  it('runs a full auto pass through all phases', async () => {
    const { trace } = await drive({}, { auto: true });
    expectGolden('run-driver.full-auto-pass', trace);
  });

  it('stops a review return loop at MAX_RETURNS', async () => {
    const { trace } = await drive(
      { 'code-review': () => ({ outcome: 'waiting', exitCode: 0, moveTo: 'implement' }) },
      { auto: true },
    );
    expectGolden('run-driver.review-returns', trace);
  });

  it('relaunches a failed step up to MAX_LAUNCHES', async () => {
    const { trace } = await drive({ research: () => ({ outcome: 'failed', exitCode: 1 }) }, { auto: true });
    expectGolden('run-driver.failed-relaunch', trace);
  });

  it('stops before the next step once the run is over the spend limit', async () => {
    const { trace } = await drive(
      {
        requirements: (_visit, ctx) => {
          ctx.opened.run.spentUsd = 30;
          return { outcome: 'ok', exitCode: 0, visit: { usd: 30 } };
        },
      },
      { auto: true },
    );
    expectGolden('run-driver.spend-stop', trace);
  });
});
