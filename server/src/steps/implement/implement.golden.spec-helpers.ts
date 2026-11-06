import { rmSync } from 'fs';
import { StepKernel } from '../step-kernel';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { AgentLauncher } from '../shared/agent-launcher';
import { AppConfig } from '../../config/env';
import { StepEventLog } from '../../history/step-event.log';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { PipelineResult, StepOptions } from '../../core/pipeline-result';
import { EnvironmentService } from '../../environment/environment.service';
import { runGit } from '../../git/git-repo.spec-helpers';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { SandboxService } from '../../sandbox/sandbox.service';
import { expectGolden, recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { RebasedPublisher } from '../shared/rebased-publisher';
import { ImplementImproveStep } from './implement-improve.step';
import { ImplementStep } from './implement.step';
import { boot, featureTree, seed, writeEnv } from './implement.step.spec-helpers';

export type GoldenApp = Awaited<ReturnType<typeof boot>>;
type App = GoldenApp;

export interface GoldenCase {
  step: 'implement' | 'implement-improve';
  key: string;
  /** Name of the golden file, without the step prefix. */
  scenario: string;
  agent: jest.Mock;
  options?: StepOptions;
  prepare?: (context: { app: App; root: string; worktree: string }) => Promise<void>;
}

function gitTrace(repo: string): { refs: string[]; subjects: string[] } {
  return {
    refs: runGit(repo, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean),
    subjects: runGit(repo, ['log', '--format=%s']).split('\n').filter(Boolean),
  };
}

/** Runs the real implement or implement-improve step against a fixture repository and compares the whole trace. */
export async function goldenRun(input: GoldenCase): Promise<PipelineResult> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-golden-'));
  let app: App | null = null;
  try {
    await writeEnv(root);
    const worktree = featureTree(root, input.key, 'billing-api');
    app = await boot(root, input.agent);
    await seed(app, input.key, 'approve');
    if (input.step === 'implement-improve') {
      const run = (await app.get(RunRepository).findRun(input.key))!;
      await app.get(DocumentRepository).putDocument(run, 'implementation', '- changed the field parser\n');
    }
    await input.prepare?.({ app, root, worktree });
    const documents = recordingDocuments(app.get(DocumentRepository));
    const common = [
      new StepKernel(
        app.get(RunRepository),
        documents,
        app.get(VisitRepository),
        app.get(FlowRepository),
        new FakeClock(),
        app.get(AppConfig),
        app.get(StepEventLog),
      ),
      app.get(SandboxService),
    ] as const;
    const step =
      input.step === 'implement'
        ? new ImplementStep(
            ...common,
            app.get(RebasedPublisher),
            app.get(CheckoutRepository),
            app.get(AgentLauncher),
            app.get(EnvironmentService),
          )
        : new ImplementImproveStep(...common, app.get(AgentLauncher), app.get(EnvironmentService));
    const result = await step.execute(input.key, input.options ?? {});
    const trace = await traceRun(app.get(DataSource), input.key, { [input.step]: documents.kinds });
    expectGolden(`${input.step}.${input.scenario}`, {
      ...trace,
      result,
      git: { clone: gitTrace(join(root, 'billing-api')), worktree: gitTrace(worktree) },
    });
    return result;
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
