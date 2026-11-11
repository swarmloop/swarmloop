import 'reflect-metadata';
import { Injectable, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../config/config.module';
import { DocumentRepository } from '../history/document.repository';
import { EventRepository } from '../history/event.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import type { VisitDraft } from '../history/visit';
import { AGENT_RUNNER } from '../agent/agent-runner';
import { PipelineModule } from '../pipeline/pipeline.module';
import { StepName } from '../contract/steps';
import { PASTE_READER } from '../integrations/linked-pages/paste-page.reader';
import { FetchFailed, HttpCallDraft, SwarmloopError } from '../core/swarmloop-error';
import { ARTIFACTS } from './contract/artifacts';
import type { InputSpec, Route, StepInput, StepResult } from './contract/step-contract';
import { BaseStep, StepContext } from './base-step';
import { StepKernel } from './step-kernel';
import { git } from '../git/git';
import { Clock } from '../core/clock';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { StepEventLog } from '../history/step-event.log';

const STUB_INPUTS = {
  repos: { artifact: ARTIFACTS.repos, need: 'start', late: true },
} as const satisfies InputSpec;

/** Throws whatever the test sets, so each case drives one path through `BaseStep.execute`. */
@Injectable()
class StubStep extends BaseStep<typeof STUB_INPUTS> {
  readonly name: StepName = 'branch';
  readonly inputs = STUB_INPUTS;
  readonly outputs = [];
  thrown: unknown = null;
  failure: Partial<VisitDraft> = {};

  constructor(kernel: StepKernel) {
    super(kernel);
  }

  protected override failureVisit(): Partial<VisitDraft> {
    return this.failure;
  }

  protected async work(): Promise<StepResult> {
    throw this.thrown;
  }
}

const INPUTS = {
  repos: { artifact: ARTIFACTS.repos, need: 'run' },
  commit: { artifact: ARTIFACTS.commit, need: 'optional' },
} as const satisfies InputSpec;

/** Hands the test the inputs it was given, and returns the result the test sets. */
class TemplateStub extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'branch';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.commit, ARTIFACTS.pipelineLog];
  route: Route = { to: 'next' };
  seen: StepInput<typeof INPUTS> | null = null;
  reread: string | null = null;

  protected async work(input: StepInput<typeof INPUTS>, ctx: StepContext): Promise<StepResult> {
    this.seen = input;
    await ctx.write(ARTIFACTS.ciSkip, 'skip\n');
    this.reread = await ctx.reread(ARTIFACTS.ciSkip);
    return {
      route: this.route,
      summary: 'stub done',
      outputs: [
        { artifact: ARTIFACTS.commit, value: 'a.ts\n' },
        { artifact: ARTIFACTS.pipelineLog, value: 'result: pass\n' },
      ],
      handoff: '- stubbed\n',
    };
  }
}

/** Does a git call before its inputs are read, as a step does when it prepares. */
class PreparingStub extends TemplateStub {
  protected override async ready(): Promise<void> {
    await git(['--version']);
  }
}

describe('base step', () => {
  it('records a plain error as failed with the step fallback text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-plain-'));
    const app = await boot(root);
    try {
      app.get(StubStep).thrown = new Error('boom');
      const result = await app.get(StubStep).execute('BASE-1');
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/ branch failed: boom \(E-[0-9a-z]{8}\)$/);
      const run = await app.get(RunRepository).findRun('BASE-1');
      expect(run?.status).toBe('failed');
      const documents = await app.get(DocumentRepository).listDocuments(run?.id ?? 0);
      expect(documents.filter((document) => document.kind === 'error').map((document) => document.body)).toEqual([
        expect.stringMatching(/^branch failed: boom \(E-[0-9a-z]{8}\)\n$/),
      ]);
    } finally {
      await app.close();
    }
  });

  it('logs the same error id as the text and masks a secret in both', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-redact-'));
    const app = await boot(root);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      app.get(StubStep).thrown = new Error('auth failed with glpat-secret123\nat somewhere');
      const result = await app.get(StubStep).execute('BASE-7');
      const id = /\((E-[0-9a-z]{8})\)$/.exec(result.message)?.[1];
      expect(result.message).toMatch(/ branch failed: auth failed with \*\*\* \(E-[0-9a-z]{8}\)$/);
      const logged = String(error.mock.calls[0][0]);
      expect(logged).toContain(id);
      expect(logged).toContain('at somewhere');
      expect(logged).not.toContain('glpat-secret123');
    } finally {
      error.mockRestore();
      await app.close();
    }
  });

  it('logs the error id and code of a SwarmloopError without changing its text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-code-'));
    const app = await boot(root);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      app.get(StubStep).thrown = new SwarmloopError('repos is missing');
      const result = await app.get(StubStep).execute('BASE-8');
      expect(result.message).toMatch(/ repos is missing$/);
      expect(String(error.mock.calls[0][0])).toMatch(/^E-[0-9a-z]{8} branch failed: code STEP_FAILED$/);
    } finally {
      error.mockRestore();
      await app.close();
    }
  });

  it('uses a SwarmloopError message as the failure line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-swarmloop-'));
    const app = await boot(root);
    try {
      app.get(StubStep).thrown = new SwarmloopError('repos is missing');
      const result = await app.get(StubStep).execute('BASE-2');
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/ repos is missing$/);
      expect(result.message).not.toContain('branch failed');
    } finally {
      await app.close();
    }
  });

  it('keeps the http calls of a FetchFailed in the visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-fetch-'));
    const app = await boot(root);
    try {
      const call: HttpCallDraft = {
        provider: 'jira',
        method: 'GET',
        url: 'https://jira.example.com/rest/api/3/issue/BASE-3',
        statusCode: 503,
        durationMs: 12,
        error: 'unavailable',
      };
      app.get(StubStep).thrown = new FetchFailed('jira is down', [call]);
      const result = await app.get(StubStep).execute('BASE-3');
      expect(result.message).toMatch(/ jira is down$/);
      const run = await app.get(RunRepository).findRun('BASE-3');
      const calls = await app.get(EventRepository).listHttpCalls(run?.id ?? 0);
      expect(calls.map((item) => [item.provider, item.url, item.statusCode])).toEqual([
        [call.provider, call.url, call.statusCode],
      ]);
    } finally {
      await app.close();
    }
  });

  it('merges the step failure visit into the failed visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-visit-'));
    const app = await boot(root);
    try {
      const step = app.get(StubStep);
      step.thrown = new Error('boom');
      step.failure = { mode: 'ask', samples: [] };
      await step.execute('BASE-5');
      const run = await app.get(RunRepository).findRun('BASE-5');
      const stats = await app.get(VisitRepository).listStats(run?.id ?? 0);
      expect(stats.map((item) => [item.step, item.status, item.mode])).toEqual([['branch', 'failed', 'ask']]);
    } finally {
      await app.close();
    }
  });

  it('reports the required document kind when it is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-missing-'));
    const app = await boot(root);
    try {
      expect(await app.get(StubStep).missingInput('BASE-4')).toBe('repos');
    } finally {
      await app.close();
    }
  });

  it('describes a server step from its class', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-describe-'));
    const app = await boot(root);
    try {
      expect(app.get(StubStep).describe({} as never)).toEqual({
        name: 'branch',
        kind: 'server',
        inputs: [{ name: 'repos', kind: 'repos', need: 'start' }],
        outputs: [],
        capabilities: {},
      });
    } finally {
      await app.close();
    }
  });

  it('describes a model step as an agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-describe-agent-'));
    const app = await boot(root);
    try {
      class AgentStub extends StubStep {
        override readonly usesModel = true;
        override readonly capabilities = { prompt: true };
      }
      const descriptor = new AgentStub(app.get(StepKernel)).describe({} as never);
      expect(descriptor.kind).toBe('agent');
      expect(descriptor.capabilities).toEqual({ prompt: true });
    } finally {
      await app.close();
    }
  });
  describe('preparation', () => {
    it('records the commands of the preparation under Preparing, and the wait between two visits', async () => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-preparing-'));
      const clock = new FakeClock();
      const app = await boot(root, clock);
      try {
        const runs = app.get(RunRepository);
        const seeded = await runs.begin('BASE-30', 'branch');
        seeded.status = 'waiting';
        await runs.saveRun(seeded);
        await app.get(DocumentRepository).putDocument(seeded, 'repos', 'demo\n');
        const step = new PreparingStub(app.get(StepKernel));
        await step.execute('BASE-30');
        clock.advance(338_000);
        await step.execute('BASE-30');

        const run = await runs.findRun('BASE-30');
        const stats = await app.get(VisitRepository).listStats(run?.id ?? 0);
        expect(stats.map((stat) => stat.preparedMs)).toEqual([null, expect.any(Number)]);
        expect(stats[1].preparedMs).toBe(338_000);

        const events = (await app.get(StepEventLog).page(run?.id ?? 0, { limit: 500 })).events;
        const preparing = events.find((event) => event.kind === 'activity.started' && event.title === 'Preparing');
        const command = events.find((event) => event.kind === 'command.started' && event.args.includes('--version'));
        expect(preparing).toBeDefined();
        expect(command?.parentSpanId).toBe(preparing && 'spanId' in preparing ? preparing.spanId : null);
      } finally {
        await app.close();
      }
    });
  });

  describe('declared inputs', () => {
    async function run(key: string, route: Route, seed = true) {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-base-template-'));
      const app = await boot(root);
      const step = new TemplateStub(app.get(StepKernel));
      step.route = route;
      if (seed) {
        const runs = app.get(RunRepository);
        const seeded = await runs.begin(key, 'branch');
        seeded.status = 'waiting';
        await runs.saveRun(seeded);
        await app.get(DocumentRepository).putDocument(seeded, 'repos', 'demo\nbilling\n');
      }
      const result = await step.execute(key);
      const stored = await app.get(RunRepository).findRun(key);
      const documents = await app.get(DocumentRepository).listDocuments(stored?.id ?? 0);
      return { app, step, result, stored, documents };
    }

    it('reads the declared inputs through their codec and hands them to work', async () => {
      const { app, step } = await run('BASE-10', { to: 'next' });
      try {
        expect(step.seen).toEqual({ repos: ['demo', 'billing'], commit: null });
      } finally {
        await app.close();
      }
    });

    it('stores the outputs in the listed order, then the handoff', async () => {
      const { app, documents } = await run('BASE-11', { to: 'next' });
      try {
        expect(documents.map((document) => document.kind)).toEqual([
          'repos',
          'ci_skip',
          'commit',
          'pipeline_log',
          'handoff',
        ]);
      } finally {
        await app.close();
      }
    });

    it('stores a document with ctx.write and reads it back with ctx.reread', async () => {
      const { app, step, documents } = await run('BASE-12', { to: 'next' });
      try {
        expect(step.reread).toBe('skip\n');
        expect(documents.find((document) => document.kind === 'ci_skip')?.body).toBe('skip\n');
      } finally {
        await app.close();
      }
    });

    it.each<[string, string, number, Route]>([
      ['wait', 'waiting', 0, { to: 'wait', reason: 'later' }],
      ['block', 'blocked', 1, { to: 'block', reason: 'stuck' }],
      ['fail', 'failed', 1, { to: 'fail', error: { code: 'x', message: 'broke' } }],
    ])('ends a %s route as a %s run with exit code %s', async (name, status, exitCode, route) => {
      const { app, result, stored } = await run(`BASE-2${name}`, route);
      try {
        expect(result.exitCode).toBe(exitCode);
        expect(result.message).toBe('stub done');
        expect(stored?.status).toBe(status);
      } finally {
        await app.close();
      }
    });

    it('fails the visit when the step returns or jumps where the tables do not allow', async () => {
      const issues = [{ id: 'branch-1', source: 'branch', title: 't', body: 'b' }];
      for (const [key, route] of [
        ['BASE-14', { to: 'return', step: 'implement', issues }],
        ['BASE-15', { to: 'jump', step: 'commit' }],
      ] as [string, Route][]) {
        const { app, result, stored } = await run(key, route);
        try {
          expect(result.exitCode).toBe(1);
          expect(result.message).toMatch(/branch may not (return|jump) to /);
          expect(stored?.status).toBe('failed');
        } finally {
          await app.close();
        }
      }
    });

    it('fails the visit with "<kind> is missing" when a run input is absent', async () => {
      const { app, step, result, stored } = await run('BASE-13', { to: 'next' }, false);
      try {
        expect(result.exitCode).toBe(1);
        expect(result.message).toMatch(/ repos is missing$/);
        expect(stored?.status).toBe('failed');
        expect(step.seen).toBeNull();
      } finally {
        await app.close();
      }
    });
  });
});

async function boot(root: string, clock?: Clock): Promise<TestingModule> {
  await writeFile(
    join(root, '.env'),
    [
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
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      '',
    ].join('\n'),
  );
  const builder = Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
    providers: [StepKernel, StubStep],
  });
  if (clock) {
    builder.overrideProvider(Clock).useValue(clock);
  }
  return builder
    .overrideProvider(PASTE_READER)
    .useValue({ read: jest.fn() })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: jest.fn() })
    .compile();
}
