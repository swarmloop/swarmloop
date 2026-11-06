import 'reflect-metadata';
import { StepKernel } from '../step-kernel';
import { mkdirSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import type { AgentRunInput } from '../../agent/agent-runner';
import { AgentLauncher } from '../shared/agent-launcher';
import { AppConfig } from '../../config/env';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { SwarmloopError } from '../../core/swarmloop-error';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import { EventRepository } from '../../history/event.repository';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { SandboxService } from '../../sandbox/sandbox.service';
import { expectGolden, recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { PrepareStep } from '../prepare/prepare.step';
import { CodeReviewStep } from './code-review.step';
import { boot, reply, result, seed, writeEnv } from './code-review.step.spec-helpers';

const KEY = 'PROJ-80';

describe('code-review step golden traces', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>> | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-review-golden-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', KEY, 'billing-api'), { recursive: true });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await rm(root, { recursive: true, force: true });
  });

  async function golden(name: string, agent: jest.Mock): Promise<void> {
    app = await boot(root, agent);
    await seed(app, KEY);
    const documents = recordingDocuments(app.get(DocumentRepository));
    const step = new CodeReviewStep(
      new StepKernel(
        app.get(RunRepository),
        documents,
        app.get(VisitRepository),
        app.get(FlowRepository),
        new FakeClock(),
        app.get(AppConfig),
      ),
      app.get(CheckoutRepository),
      app.get(EventRepository),
      app.get(PrepareStep),
      app.get(SandboxService),
      app.get(AgentLauncher),
    );
    const done = await step.execute(KEY);
    // The reviewers run inside the step: each of their visits shares the kinds the step read.
    const reads = Object.fromEntries(
      ['code-review', ...agent.mock.calls.map((call) => (call[0] as AgentRunInput).step)].map((s) => [
        s,
        documents.kinds,
      ]),
    );
    const trail = await traceRun(app.get(DataSource), KEY, reads);
    expectGolden(`code-review.${name}`, {
      result: { exitCode: done.exitCode, message: done.message },
      agentSteps: agent.mock.calls.map((call) => (call[0] as AgentRunInput).step).sort(),
      ...trail,
    });
  }

  it('all reviewers ok', async () => {
    await golden(
      'all-ok',
      jest.fn(async (input: AgentRunInput) =>
        result(input.step.endsWith('report') ? 'The change holds together.\n' : reply(input.step, 'ok'), input.step),
      ),
    );
  });

  it('one reviewer returns: waiting, moves to implement with a return document', async () => {
    await golden(
      'reviewer-returns',
      jest.fn(async (input: AgentRunInput) =>
        result(
          input.step.endsWith('report')
            ? 'The change needs work.\n'
            : reply(input.step, input.step.endsWith('quality') ? 'return' : 'ok'),
          input.step,
        ),
      ),
    );
  });

  it('a thrown SwarmloopError fails the visit with its message', async () => {
    await golden('swarmloop-error', jest.fn().mockRejectedValue(new SwarmloopError('reviewer refused')));
  });

  it('a plain Error from the agent fails the visit as "code-review failed"', async () => {
    await golden('plain-error', jest.fn().mockRejectedValue(new Error('spawn failed')));
  });
});
