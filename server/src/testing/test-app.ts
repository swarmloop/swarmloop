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
import { BaseStep, type StepContext } from '../steps/base-step';
import { ImplementStep } from '../steps/implement/implement.step';
import { MergeRequestStep } from '../steps/merge-request/merge-request.step';
import { PipelineStep } from '../steps/pipeline/pipeline.step';
import { StepRegistry } from '../steps/step.registry';
import type { StepCapabilities, StepResult } from '../steps/contract/step-contract';
import type { Step, StepSnapshot } from '../steps/step';
import type { StepOptions } from '../core/pipeline-result';
import { RunRepository } from '../history/run.repository';
import { StepKernel } from '../steps/step-kernel';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PipelineService } from '../pipeline/pipeline.service';
import { Reconciler } from '../pipeline/reconciler';

const MACHINE_TOKEN = 'test-machine-token';

type FakeSandbox = Record<string, (...args: never[]) => Promise<unknown>>;

interface TestAppOptions {
  root?: string;
  runner?: FakeAgentRunner;
  /** Replaces calls of the fake sandbox, for a spec that needs a container. */
  sandbox?: FakeSandbox;
  /** Lines of the `.env` on top of the isolation lines; every other setting is the shipped default. */
  env?: Record<string, string>;
  /** No `.env` is written: the isolation values are the launch environment, and everything else is the shipped default. */
  envFile?: boolean;
  /** These steps are the real ones. The others stay scripted. */
  realSteps?: StepName[];
  /** A split run takes the real implement step, with its passes, in place of the scripted one. */
  realImplement?: boolean;
  /** The merge-request and pipeline steps are the real ones, on a gitlab host the spec swaps for a fake. The other steps stay scripted. */
  realHost?: boolean;
  /** Starts the reconciler's timer. Off by default: a test drives its passes itself, one awaited pass at a time. */
  reconcilerTimer?: boolean;
  /** The app removes the root when it closes. Defaults to true for a root it made. */
  ownsRoot?: boolean;
}

/** What stands for the agent process: it is told the step and the whole launch, and answers a real step's launch. */
export interface FakeAgentRunner {
  readonly steps: string[];
  run(step: string, input: AgentRunInput): Promise<unknown>;
}

export class ScriptedFakeAgentRunner implements FakeAgentRunner {
  readonly steps: string[] = [];

  run(step: string): Promise<void> {
    this.steps.push(step);
    return Promise.resolve();
  }
}

class FakeCodeHost {
  open(): Promise<{ url: string }> {
    return Promise.resolve({ url: 'https://code.example/test/merge_requests/1' });
  }
}

export class ScriptedStep extends BaseStep<Record<string, never>> {
  readonly inputs = {};
  readonly outputs = [];
  override readonly usesModel = false;
  override readonly capabilities: StepCapabilities;

  constructor(
    readonly name: StepName,
    kernel: StepKernel,
    private readonly runner: { run(input: { step: string }): Promise<void> },
    private readonly codeHost: FakeCodeHost,
  ) {
    super(kernel);
    this.capabilities = { prompt: name === 'requirements', projects: name === 'prepare' };
  }

  override missingInput(): Promise<null> {
    return Promise.resolve(null);
  }

  protected async work(_input: object, context: StepContext): Promise<StepResult> {
    await this.runner.run({ step: this.name });
    if (this.name === 'merge-request') await this.codeHost.open();
    return { route: { to: 'next' }, summary: `${context.opened.startedAt} complete`, outputs: [] };
  }
}

export interface TestApp {
  app: INestApplication;
  root: string;
  clock: FakeClock;
  codeHost: FakeCodeHost;
  runner: FakeAgentRunner;
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
    .useValue({ run: (input: AgentRunInput) => runner.run(input.step, input) })
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

  if (options.realImplement) {
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

  for (const name of options.realSteps ?? []) steps.set(name, realStep(module, name));

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
      return createTestApp({ ...options, root, runner, ownsRoot });
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
