import 'reflect-metadata';
import { StepKernel } from '../step-kernel';
import { mkdirSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/env';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { SwarmloopError } from '../../core/swarmloop-error';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { expectGolden, recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { CheckoutService } from '../shared/checkout.service';
import { PrepareStep } from './prepare.step';
import { boot, git, repoWithMain, seedRequirements } from './prepare.step.spec-helpers';

const KEY = 'PROJ-9';

describe('prepare step golden traces', () => {
  let parent: string;
  let app: Awaited<ReturnType<typeof boot>> | undefined;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-golden-'));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(parent, { recursive: true, force: true });
  });

  /** `failOn` makes the handoff read of the stubbed document store throw, after the worktree is made. */
  async function golden(name: string, failOn?: Error): Promise<void> {
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithMain(parent, 'app');
    app = await boot(swarm, '..');
    await seedRequirements(app, KEY);
    const runs = app.get(RunRepository);
    const run = (await runs.findRun(KEY))!;
    run.projects = 'app\n';
    await runs.saveRun(run);
    const real = app.get(DocumentRepository);
    const store = Object.create(real) as DocumentRepository;
    if (failOn) {
      store.latestBody = (key, kind) => (kind === 'handoff' ? Promise.reject(failOn) : real.latestBody(key, kind));
    }
    const documents = recordingDocuments(store);
    const kernel = new StepKernel(
      runs,
      documents,
      app.get(VisitRepository),
      app.get(FlowRepository),
      new FakeClock(),
      app.get(AppConfig),
    );
    const step = new PrepareStep(
      kernel,
      app.get(CheckoutRepository),
      new CheckoutService(kernel, app.get(CodeHostRegistry)),
    );
    const done = await step.execute(KEY);
    const trail = await traceRun(app.get(DataSource), KEY, { prepare: documents.kinds });
    expectGolden(`prepare.${name}`, {
      result: { exitCode: done.exitCode, message: done.message },
      git: {
        refs: git(clone, ['for-each-ref', '--format=%(refname)']).split('\n'),
        worktrees: git(clone, ['worktree', 'list']).split('\n').length,
        log: git(clone, ['log', '--format=%s']).split('\n'),
      },
      ...trail,
    });
  }

  it('ok: prepares the stored project', async () => {
    await golden('ok');
  });

  it('a thrown SwarmloopError fails the visit with its message', async () => {
    await golden('swarmloop-error', new SwarmloopError('handoff is locked'));
  });

  it('a plain Error fails the visit with the error detail', async () => {
    await golden('plain-error', new Error('disk full'));
  });
});
