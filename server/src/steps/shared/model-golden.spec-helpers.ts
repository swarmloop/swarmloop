import 'reflect-metadata';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { mkdirSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { AGENT_RUNNER } from '../../agent/agent-runner';
import { AgentLauncher } from './agent-launcher';
import { SwarmloopConfigModule } from '../../config/config.module';
import { AppConfig } from '../../config/env';
import { Clock } from '../../core/clock';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { StepEventLog } from '../../history/step-event.log';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { SandboxService } from '../../sandbox/sandbox.service';
import { recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { writeEnv } from '../implement/implement.step.spec-helpers';

interface GoldenOptions {
  agent?: jest.Mock;
  /** Directories created under `worktrees/` of the root. */
  worktrees?: string[];
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/** A fresh root, a pinned clock, and the repositories a real step is built from. `documents` records every kind read. */
export async function goldenApp(prefix: string, options: GoldenOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), `swarmloop-${prefix}-`));
  await writeEnv(root, undefined, { EPIC_EFFORT: '' });
  for (const path of options.worktrees ?? []) mkdirSync(join(root, 'worktrees', path), { recursive: true });
  const builder = Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: options.agent ?? jest.fn() })
    .overrideProvider(SandboxService)
    .useValue({ assertReady: jest.fn().mockResolvedValue(undefined) })
    .overrideProvider(Clock)
    .useValue(new FakeClock());
  const app = await (options.configure?.(builder) ?? builder).compile();
  const documents = recordingDocuments(app.get(DocumentRepository));
  return {
    root,
    app,
    documents,
    seedDocuments: app.get(DocumentRepository),
    runs: app.get(RunRepository),
    visits: app.get(VisitRepository),
    flows: app.get(FlowRepository),
    clock: app.get(Clock),
    config: app.get(AppConfig),
    stepEvents: app.get(StepEventLog),
    sandbox: app.get(SandboxService),
    launcher: app.get(AgentLauncher),
    trace: (key: string, step: string) => traceRun(app.get(DataSource), key, { [step]: documents.kinds }),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
