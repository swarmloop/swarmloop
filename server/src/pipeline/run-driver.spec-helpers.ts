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
import { createTestApp, type TestApp } from '../testing/test-app';
import { recordingDocuments, traceRun, type RecordingDocuments } from '../testing/step-trace.spec-helpers';
import { PipelineService } from './pipeline.service';
import { deriveState } from '../history/run-state';
import { actionsFor } from '../contract/run-state';

export const KEY = 'PROJ-1';

export type Script = (visit: number, ctx: StepContext) => Omit<StepEnd, 'line'> | Promise<Omit<StepEnd, 'line'>>;

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
        const end = await this.script(this.count, ctx);
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

export const ok: Script = () => ({ outcome: 'ok', exitCode: 0 });

/** The steps in `names` end their visits as their scripts say; every other step is the one the app has. */
export function installScripts(app: TestApp, scripts: Partial<Record<StepName, Script>>, names: readonly StepName[]) {
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
  for (const name of names) {
    steps.set(name, new DriverStep(name, recordingDocuments(documents), base, scripts[name] ?? ok));
  }
  const registry = app.app.get<{ get(name: StepName): Step | null }>(StepRegistry);
  const original = registry.get.bind(registry);
  registry.get = (name) => steps.get(name) ?? original(name);
  return steps;
}

export async function drive(
  scripts: Partial<Record<StepName, Script>>,
  options: StepOptions,
  key = KEY,
  env: Record<string, string> = {},
) {
  const app = await createTestApp({ env });
  try {
    const steps = installScripts(
      app,
      scripts,
      STEPS.filter((name) => name !== 'done'),
    );
    const result = await app.app.get(PipelineService).runThrough(key, options);
    const reads = Object.fromEntries([...steps].map(([name, step]) => [name, step.recorder.kinds]));
    const stored = await app.app.get(RunRepository).findRun(key);
    const { state, reason } = stored ? deriveState(stored) : { state: null, reason: null };
    const actions = state ? actionsFor(state, reason?.code ?? null) : [];
    const trace = { result, ...(await traceRun(app.app.get(DataSource), key, reads)) };
    return { result, trace, state, reason, actions };
  } finally {
    await app.close();
  }
}
