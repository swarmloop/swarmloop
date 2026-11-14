import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommandHandlers } from '../api/command-handlers';
import { ChatService } from '../api/chat.service';
import { HealthController } from '../api/health.controller';
import { LiveGateway } from '../api/live.gateway';
import { SubtaskClose } from '../api/subtask-close';
import { RunCommandsService } from '../api/run-commands.service';
import { RunSubtaskCommandsService } from '../api/run-subtask-commands.service';
import { RunQueriesService } from '../api/run-queries.service';
import { RunRebaseService } from '../api/run-rebase.service';
import { ReadinessController } from '../api/readiness.controller';
import { RunsController } from '../api/runs.controller';
import { ReadinessModule } from '../readiness/readiness.module';
import { ShellService } from '../api/shell.service';
import { AGENT_RUNNER, type AgentRunInput } from '../agent/agent-runner';
import { SwarmloopConfigModule } from '../config/config.module';
import type { SwarmloopEnv } from '../config/env';
import { Clock } from '../core/clock';
import { writeEnvOverrides } from './env.spec-helpers';
import { realStep } from './real-steps';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { STEPS, type StepName } from '../contract/steps';
import { HistoryModule } from '../history/history.module';
import { LiveModule } from '../live/live.module';
import { ProvidersModule } from '../integrations/providers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { SandboxService } from '../sandbox/sandbox.service';
import { ResearchStep } from '../steps/research/research.step';
import { PlanStep } from '../steps/plan/plan.step';
import { PlanImproveStep } from '../steps/plan-improve/plan-improve.step';
import { ImplementStep } from '../steps/implement/implement.step';
import { ImplementImproveStep } from '../steps/implement/implement-improve.step';
import { CodeReviewStep } from '../steps/code-review/code-review.step';
import { MergeRequestStep } from '../steps/merge-request/merge-request.step';
import { PipelineStep } from '../steps/pipeline/pipeline.step';
import { StepRegistry } from '../steps/step.registry';
import type { Step, StepSnapshot } from '../steps/step';
import type { StepOptions } from '../core/pipeline-result';
import { RunRepository } from '../history/run.repository';
import { StepKernel } from '../steps/step-kernel';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PipelineService } from '../pipeline/pipeline.service';
import { Reconciler } from '../pipeline/reconciler';
import { BlockAgentRunner } from './result-answer';
import { FakeCodeHost, ScriptedFakeAgentRunner, ScriptedStep, seededStep } from './test-app-steps';

export { ScriptedFakeAgentRunner, ScriptedStep };

const MACHINE_TOKEN = 'test-machine-token';
/** The steps whose agent answers in result blocks. */
const BLOCK_STEPS = ['research', 'plan', 'plan-improve', 'implement', 'implement-improve'];

/** A step whose agent answers in a result block: the ones above, every code reviewer and the report. */
function answersInBlocks(step: string): boolean {
  return BLOCK_STEPS.includes(step) || step.startsWith('code-review-');
}

type FakeSandbox = Record<string, (...args: never[]) => Promise<unknown>>;

/**
 * What stands for the agent process: it is told the step and the whole launch. A scripted step only has its launch
 * noted; a real step takes what a launch returns, and one that returns nothing is answered by `blocks`.
 */
export interface FakeAgentRunner {
  readonly steps: string[];
  run(step: string, input: AgentRunInput): Promise<unknown>;
}

interface TestAppOptions {
  root?: string;
  runner?: FakeAgentRunner;
  /** The agent of the real research, plan, plan-improve, implement and code-review steps: it answers in result blocks. Without one it answers the defaults of `BlockAgentRunner`. */
  blocks?: BlockAgentRunner;
  /** Replaces calls of the fake sandbox, for a spec that needs a container. */
  sandbox?: FakeSandbox;
  /** Lines of the `.env` on top of the isolation lines; every other setting is the shipped default. */
  env?: Record<string, string>;
  /** No `.env` is written: the isolation values are the launch environment, and everything else is the shipped default. */
  envFile?: boolean;
  /** These steps are the real ones, besides research, plan and plan-improve, which always are. The others stay scripted. */
  realSteps?: StepName[];
  /** Defaults to 'all': every run takes the real implement steps. True limits that to split parents; false keeps them scripted. */
  realImplement?: boolean | 'all';
  /** Defaults to true: the real reviewers and report answer in result blocks. False keeps code review scripted. */
  realReview?: boolean;
  /** The merge-request and pipeline steps use a gitlab host the spec swaps for a fake. */
  realHost?: boolean;
  /** Starts the reconciler's timer. Off by default: a test drives its passes itself, one awaited pass at a time. */
  reconcilerTimer?: boolean;
  /** The app removes the root when it closes. Defaults to true for a root it made. */
  ownsRoot?: boolean;
}

export interface TestApp {
  app: INestApplication;
  root: string;
  clock: FakeClock;
  codeHost: FakeCodeHost;
  runner: FakeAgentRunner;
  /** The agent of the real research, plan, plan-improve, implement and code-review steps. */
  blocks: BlockAgentRunner;
  pipeline: PipelineService;
  url: string;
  /** The machine token as a bearer: the API takes no request without a session or this. */
  auth: { authorization: string };
  close(): Promise<void>;
  /** A restart: this app stops and a new one starts on the same root and database. The new app owns the root. */
  restart(): Promise<TestApp>;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const ownsRoot = options.ownsRoot ?? options.root === undefined;
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'swarmloop-test-app-')));
  mkdirSync(root, { recursive: true });
  const hostEnv = options.realHost
    ? { GITLAB_BASE_URL: 'https://gitlab.example', GITLAB_TOKEN: 'token', ...options.env }
    : options.env;
  const isolation = isolationEnv(root, hostEnv);
  const envFile = join(root, '.env');
  if (options.envFile !== false) await writeEnvOverrides(root, isolation);
  const clock = new FakeClock();
  const runner = options.runner ?? new ScriptedFakeAgentRunner();
  const blocks = options.blocks ?? new BlockAgentRunner();
  const codeHost = new FakeCodeHost();
  const steps = new Map<StepName, Step>();
  const registry = {
    get: (name: StepName) => steps.get(name) ?? null,
    describe: (env: SwarmloopEnv) => [...steps.values()].map((step) => step.describe(env)),
  };
  const module = await Test.createTestingModule({
    imports: [
      options.envFile === false
        ? SwarmloopConfigModule.forRoot(envFile, isolation)
        : SwarmloopConfigModule.forRoot(envFile),
      HistoryModule,
      AuthModule,
      PipelineModule,
      LiveModule,
      ProvidersModule,
      SandboxModule,
      ReadinessModule,
    ],
    controllers: [HealthController, RunsController, ReadinessController],
    providers: [
      RunQueriesService,
      RunCommandsService,
      RunSubtaskCommandsService,
      SubtaskClose,
      RunRebaseService,
      ChatService,
      ShellService,
      CommandHandlers,
      LiveGateway,
    ],
  })
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(StepRegistry)
    .useValue(registry)
    .overrideProvider(AGENT_RUNNER)
    .useValue({
      run: async (input: AgentRunInput) => {
        const answer = await runner.run(input.step, input);
        return answer ?? (answersInBlocks(input.step) ? blocks.run(input) : undefined);
      },
    })
    .overrideProvider(SandboxService)
    .useValue({
      assertReady: () => Promise.resolve(),
      kill: () => Promise.resolve(),
      attemptRunning: () => Promise.resolve(false),
      killAttempt: () => Promise.resolve(true),
      ...options.sandbox,
    })
    .compile();

  for (const name of STEPS) {
    if (name === 'done') continue;
    steps.set(name, new ScriptedStep(name, module.get(StepKernel), module.get(AGENT_RUNNER), codeHost));
  }

  for (const name of options.realSteps ?? []) steps.set(name, realStep(module, name));

  // Research, plan and plan-improve are always the real steps, answered in blocks.
  for (const [name, real] of [
    ['research', module.get(ResearchStep)],
    ['plan', module.get(PlanStep)],
    ['plan-improve', module.get(PlanImproveStep)],
  ] as const) {
    steps.set(name, seededStep(real, module, root));
  }

  if ((options.realImplement ?? 'all') === 'all') {
    steps.set('implement', module.get(ImplementStep));
    steps.set('implement-improve', module.get(ImplementImproveStep));
  } else if (options.realImplement) {
    // Only a split run takes the real step, so the runs of its subtasks go through the scripted one.
    const real = module.get(ImplementStep);
    const scripted = steps.get('implement') as Step;
    const runs = module.get(RunRepository);
    steps.set(
      'implement',
      Object.create(scripted, {
        execute: {
          value: async (key: string, stepOptions: StepOptions, snapshot?: StepSnapshot) =>
            ((await runs.findRun(key))?.split ? real : scripted).execute(key, stepOptions, snapshot),
        },
      }) as Step,
    );
  }

  if (options.realReview ?? true) {
    steps.set('code-review', module.get(CodeReviewStep));
  }

  if (options.realHost) {
    steps.set('merge-request', module.get(MergeRequestStep));
    steps.set('pipeline', module.get(PipelineStep));
  }

  const app = module.createNestApplication();
  try {
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    await module.close();
    if (ownsRoot) await rm(root, { recursive: true, force: true });
    throw error;
  }
  if (options.reconcilerTimer) app.get(Reconciler).schedule();
  const server = app.getHttpServer() as Server;
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    await app.close();
    if (ownsRoot) await rm(root, { recursive: true, force: true });
    throw new Error('test app did not bind to a TCP port');
  }

  return {
    app,
    root,
    clock,
    codeHost,
    runner,
    blocks,
    pipeline: app.get(PipelineService),
    url: `http://127.0.0.1:${address.port}`,
    auth: { authorization: `Bearer ${options.env?.SWARMLOOP_TOKEN ?? MACHINE_TOKEN}` },
    close: async () => {
      try {
        await app.close();
      } finally {
        if (ownsRoot) await rm(root, { recursive: true, force: true });
      }
    },
    restart: async () => {
      await app.close();
      return createTestApp({ ...options, root, runner, blocks, ownsRoot });
    },
  };
}

/** What keeps one app apart from the machine and from other apps: its root, loopback, a free port and the machine token. */
function isolationEnv(root: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SWARMLOOP_API_PORT: '0',
    SWARMLOOP_API_HOST: '127.0.0.1',
    SWARMLOOP_ROOT: root,
    SWARMLOOP_TOKEN: MACHINE_TOKEN,
    ...overrides,
  };
}
