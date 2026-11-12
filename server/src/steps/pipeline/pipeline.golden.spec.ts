import { EnvironmentService } from '../../environment/environment.service';
import 'reflect-metadata';
import { StepKernel } from '../step-kernel';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/env';
import { StepEventLog } from '../../history/step-event.log';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { RunStop } from '../../agent/run-stop';
import { DocumentRepository } from '../../history/document.repository';
import { EventRepository } from '../../history/event.repository';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { expectGolden, recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { RunRebase } from '../run-rebase';
import { PipelineStep } from './pipeline.step';
import { boot, call, job, one, seed, shot } from './pipeline.step.spec-helpers';

const KEY = 'PROJ-300';

describe('pipeline step golden traces', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>> | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-golden-'));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(root, { recursive: true, force: true });
  });

  async function golden(name: string, read: jest.Mock, trace: jest.Mock = jest.fn(), body = one): Promise<void> {
    app = await boot(root, read, trace);
    await seed(app, KEY, body);
    const documents = recordingDocuments(app.get(DocumentRepository));
    const step = new PipelineStep(
      new StepKernel(
        app.get(RunRepository),
        documents,
        app.get(VisitRepository),
        app.get(FlowRepository),
        new FakeClock(),
        app.get(AppConfig),
        app.get(StepEventLog),
      ),
      app.get(EventRepository),
      app.get(CodeHostRegistry),
      app.get(RunRebase),
      app.get(RunStop),
      app.get(EnvironmentService),
    );
    const result = await step.execute(KEY);
    const trail = await traceRun(app.get(DataSource), KEY, { pipeline: documents.kinds });
    expectGolden(`pipeline.${name}`, { result: { exitCode: result.exitCode, message: result.message }, ...trail });
  }

  it('passed: finishes the run', async () => {
    await golden(
      'passed',
      jest.fn(() => Promise.resolve({ snapshot: shot('success', [job(8, 'lint', true)]), httpCalls: [call('GET')] })),
    );
  });

  it('failed: returns to implement with the job log', async () => {
    await golden(
      'failed',
      jest.fn(() =>
        Promise.resolve({
          snapshot: shot('failed', [job(7, 'unit', false), job(8, 'lint', true)]),
          httpCalls: [call('GET')],
        }),
      ),
      jest.fn((_project: string, jobId: number) =>
        Promise.resolve({ trace: `log ${jobId}\n`, httpCalls: [call('GET')] }),
      ),
    );
  });

  it('a thrown SwarmloopError fails the visit with its message', async () => {
    await golden('swarmloop-error', jest.fn(), jest.fn(), '');
  });

  it('a plain Error from the host fails the visit as "pipeline failed"', async () => {
    await golden('plain-error', jest.fn().mockRejectedValue(new Error('socket hang up')));
  });
});
