import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
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
import { RunQueriesService } from '../api/run-queries.service';
import { RunRebaseService } from '../api/run-rebase.service';
import { RunsController } from '../api/runs.controller';
import { ShellService } from '../api/shell.service';
import { AGENT_RUNNER } from '../agent/agent-runner';
import { SwarmloopConfigModule } from '../config/config.module';
import type { SwarmloopEnv } from '../config/env';
import { Clock } from '../core/clock';
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
  runner?: ScriptedFakeAgentRunner;
  /** Replaces calls of the fake sandbox, for a spec that needs a container. */
  sandbox?: FakeSandbox;
  /** Lines of the `.env` that replace the defaults of `testEnv`. */
  env?: Record<string, string>;
  /** A split run takes the real implement step, with its passes, in place of the scripted one. */
  realImplement?: boolean;
  /** The merge-request and pipeline steps are the real ones, on a gitlab host the spec swaps for a fake. The other steps stay scripted. */
  realHost?: boolean;
  /** Starts the reconciler's timer. Off by default: a test drives its passes itself, one awaited pass at a time. */
  reconcilerTimer?: boolean;
  /** The app removes the root when it closes. Defaults to true for a root it made. */
  ownsRoot?: boolean;
}

export class ScriptedFakeAgentRunner {
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

class ScriptedStep extends BaseStep<Record<string, never>> {
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
  runner: ScriptedFakeAgentRunner;
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
  await writeFile(join(root, '.env'), testEnv(root, hostEnv));
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
      SwarmloopConfigModule.forRoot(join(root, '.env')),
      HistoryModule,
      AuthModule,
      PipelineModule,
      LiveModule,
      ProvidersModule,
      SandboxModule,
    ],
    controllers: [HealthController, RunsController],
    providers: [
      RunQueriesService,
      RunCommandsService,
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
    .useValue({ run: (input: { step: string }) => runner.run(input.step) })
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

function testEnv(root: string, overrides: Record<string, string> = {}): string {
  return [
    'RUNTIME=cursor',
    'REQUIREMENTS_VIA=direct',
    'ISSUE_TRACKER=jira',
    'JIRA_BASE_URL=',
    'JIRA_EMAIL=',
    'JIRA_API_TOKEN=',
    'GITLAB_BASE_URL=',
    'GITLAB_TOKEN=',
    'GITHUB_BASE_URL=',
    'GITHUB_TOKEN=',
    'CURSOR_API_KEY=',
    'ANTHROPIC_API_KEY=',
    'MAX_AGENT_CALLS=20',
    'MAX_RETURNS=3',
    'MAX_LAUNCHES=3',
    'MAX_RUN_USD=25',
    'IDLE_TIMEOUT_MS=900000',
    'TICK_MS=15000',
    'REQUIREMENTS_TIMEOUT_MS=600000',
    'RESEARCH_TIMEOUT_MS=900000',
    'PLAN_TIMEOUT_MS=1200000',
    'IMPLEMENT_TIMEOUT_MS=1800000',
    'CODE_REVIEW_TIMEOUT_MS=900000',
    'MERGE_REQUEST_TIMEOUT_MS=600000',
    'PIPELINE_TIMEOUT_MS=1800000',
    'PIPELINE_START_TIMEOUT_MS=180000',
    'MODEL_PLAN=opus-5.5-extra-high',
    'MODEL_IMPLEMENT=grok-4.7',
    'SPLIT=off',
    'SWARMLOOP_API_PORT=0',
    'SWARMLOOP_API_HOST=127.0.0.1',
    `SWARMLOOP_ROOT=${root}`,
    `SWARMLOOP_TOKEN=${MACHINE_TOKEN}`,
    ...Object.entries(overrides).map(([name, value]) => `${name}=${value}`),
    '',
  ].join('\n');
}
