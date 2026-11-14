import { AGENT_RUNNER } from '../agent/agent-runner';
import { StepStopped } from '../agent/step-stopped';
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { request } from '../integrations/http';
import { issueOf } from '../steps/shared/handoff';
import { result } from '../steps/implement/implement.step.spec-helpers';
import { git } from '../git/git';
import type { StepEventKind } from '../contract/step-events';
import type { StepName } from '../contract/steps';
import type { StepEventLog } from '../history/step-event.log';
import { BaseStep, VisitLeftOpen, type StepContext } from '../steps/base-step';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { lateInput } from '../steps/agent-step';
import type { InputSpec, StepResult } from '../steps/contract/step-contract';
import { ResearchStep } from '../steps/research/research.step';
import { StepKernel } from '../steps/step-kernel';
import { goldenApp } from '../steps/shared/model-golden.spec-helpers';
import { recordStepEvent } from '../core/step-event-scope';

const INPUTS = { requirements: { artifact: ARTIFACTS.requirements, need: 'run' } } as const satisfies InputSpec;

type Golden = Awaited<ReturnType<typeof goldenApp>>;

const RECEIVER_INPUTS = { ...INPUTS, returns: lateInput(ARTIFACTS.issues) } as const satisfies InputSpec;

/** A server step that reads the issues sent back to it. */
class ReceiverStep extends BaseStep<typeof RECEIVER_INPUTS> {
  readonly inputs = RECEIVER_INPUTS;
  readonly outputs = [ARTIFACTS.implementation];

  constructor(
    readonly name: StepName,
    kernel: StepKernel,
  ) {
    super(kernel);
  }

  protected work(_input: unknown, ctx: StepContext): Promise<StepResult> {
    return Promise.resolve({ route: { to: 'next' }, summary: `${ctx.opened.startedAt} done`, outputs: [] });
  }
}

/** A server step whose body is the script of the spec. */
class ProbeStep extends BaseStep<typeof INPUTS> {
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.implementation, ARTIFACTS.issues, ARTIFACTS.log];

  constructor(
    readonly name: StepName,
    kernel: StepKernel,
    private readonly script: (ctx: StepContext) => Promise<StepResult>,
  ) {
    super(kernel);
  }

  protected work(_input: unknown, ctx: StepContext): Promise<StepResult> {
    return this.script(ctx);
  }
}

/** Every kind a scenario wrote, so the last spec can check that none of the union is missing. */
const seen = new Set<string>();

const ALL_KINDS: Record<StepEventKind, true> = {
  'input.received': true,
  'attempt.started': true,
  'attempt.finished': true,
  'attempt.interrupted': true,
  'command.started': true,
  'command.finished': true,
  'http.call': true,
  'agent.launched': true,
  'agent.finished': true,
  'artifact.produced': true,
  'issue.opened': true,
  'handoff.sent': true,
  'handoff.received': true,
  'issue.resolved': true,
  'session.changed': true,
  'context.manifest': true,
  'agent.tool': true,
  'agent.message': true,
  'host.suspended': true,
  'agent.limited': true,
  'agent.effort_capped': true,
  'agent.loop_hint': true,
  'activity.started': true,
  'activity.finished': true,
};

describe('step events', () => {
  let golden: Golden;
  let repo: string;

  async function seed(key: string): Promise<void> {
    const run = await golden.runs.begin(key, 'prepare');
    run.status = 'waiting';
    run.currentStep = 'commit';
    await golden.runs.saveRun(run);
    await golden.seedDocuments.putDocument(run, 'requirements', '{"prompt":"ship the field"}\n');
  }

  async function eventsOf(key: string) {
    const run = await golden.runs.findRun(key);
    const page = await golden.stepEvents.page(run?.id ?? 0, { limit: 500 });
    page.events.forEach((event) => seen.add(event.kind));
    return page.events;
  }

  const probe = (name: StepName, script: (ctx: StepContext) => Promise<StepResult>, kernel?: StepKernel) =>
    new ProbeStep(
      name,
      kernel ??
        new StepKernel(
          golden.runs,
          golden.documents,
          golden.visits,
          golden.flows,
          golden.clock,
          golden.config,
          golden.stepEvents,
        ),
      script,
    );

  const finished = (ctx: StepContext): StepResult => ({
    route: { to: 'next' },
    summary: `${ctx.opened.startedAt} done`,
    outputs: [{ artifact: ARTIFACTS.implementation, value: 'a note' }],
    handoff: 'notes for the next step',
  });

  beforeEach(async () => {
    golden = await goldenApp('step-events', {
      agent: jest.fn().mockResolvedValue(result('summary:\n- ok\nquestions:\n- none')),
      worktrees: ['E-1/demo'],
    });
    repo = join(golden.root, 'worktrees', 'E-1', 'demo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
  });

  // The scenarios run in any order, so the kinds are compared once all of them have run.
  afterAll(() => {
    expect([...seen].sort()).toEqual(Object.keys(ALL_KINDS).sort());
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await golden.close();
  });

  it('writes a server step in order: attempt, inputs, work, artifacts, handoff, end', async () => {
    await seed('E-1');
    const step = probe('commit', async (ctx) => {
      await git(['-C', repo, 'rev-parse', '--git-dir']);
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      await request(golden.clock, 'https://code.example/api?token=abc', {}, ctx.calls);
      return finished(ctx);
    });
    await step.execute('E-1');
    const events = await eventsOf('E-1');
    expect(events.map((event) => event.kind)).toEqual([
      'attempt.started',
      'input.received',
      'command.started',
      'command.finished',
      'http.call',
      'artifact.produced',
      'handoff.sent',
      'attempt.finished',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events[0]).toMatchObject({ stepKind: 'server', agent: null });
    expect(events[1]).toMatchObject({ name: 'requirements', documentId: 1, summary: 'ship the field' });
    expect(events[2]).toMatchObject({ executable: 'git', repo: 'demo', cwd: 'worktrees/E-1/demo' });
    expect(events[3]).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(events[4]).toMatchObject({ method: 'GET', url: 'https://code.example/api', statusCode: 200 });
    expect(events[5]).toMatchObject({ artifactKind: 'implementation' });
    expect(events[6]).toMatchObject({ targetStep: 'merge-request', artifactKinds: ['implementation'], issueIds: [] });
    expect(events[7]).toMatchObject({ route: 'ok', summary: expect.stringContaining('done') });
  });

  it('writes an agent step with the launch of its agent', async () => {
    await seed('E-1');
    const step = new ResearchStep(
      new StepKernel(
        golden.runs,
        golden.documents,
        golden.visits,
        golden.flows,
        golden.clock,
        golden.config,
        golden.stepEvents,
      ),
      golden.sandbox,
      golden.launcher,
    );
    await step.execute('E-1');
    const events = await eventsOf('E-1');
    const kinds = events.map((event) => event.kind);
    expect(kinds[0]).toBe('attempt.started');
    const before = kinds.slice(1, kinds.indexOf('agent.launched'));
    expect(before.slice(-2)).toEqual(['session.changed', 'context.manifest']);
    expect(before.slice(0, -2).every((kind) => kind === 'input.received')).toBe(true);
    expect(kinds.slice(kinds.indexOf('agent.launched'), kinds.indexOf('agent.launched') + 2)).toEqual([
      'agent.launched',
      'agent.finished',
    ]);
    expect(kinds.slice(-2)).toEqual(['handoff.sent', 'attempt.finished']);
    expect(kinds).toContain('artifact.produced');
    expect(events[0]).toMatchObject({ stepKind: 'agent', agent: { runtime: expect.any(String) } });
  });

  it('records an activity with its commands as children, and finishes one that throws', async () => {
    await seed('E-1');
    const step = probe('commit', async (ctx) => {
      await ctx.activity(
        'Check out feature/x',
        async () => {
          await git(['-C', repo, 'rev-parse', '--git-dir']);
          await git(['-C', repo, 'status', '--porcelain']);
        },
        () => 'on feature/x at abc1234',
      );
      await ctx
        .activity('Break', async () => {
          await git(['-C', repo, 'rev-parse', 'no-such-ref']).catch(() => undefined);
          throw new Error('nope\nsecond line');
        })
        .catch(() => undefined);
      return finished(ctx);
    });
    await step.execute('E-1');
    const events = await eventsOf('E-1');
    const [first, second] = events.filter((event) => event.kind === 'activity.started');
    const commands = events.filter((event) => event.kind === 'command.started');
    expect(first).toMatchObject({ title: 'Check out feature/x', parentSpanId: null });
    expect(commands.map((event) => event.parentSpanId)).toEqual([
      (first as { spanId: string }).spanId,
      (first as { spanId: string }).spanId,
      (second as { spanId: string }).spanId,
    ]);
    expect(events.filter((event) => event.kind === 'activity.finished')).toMatchObject([
      { title: 'Check out feature/x', result: 'on feature/x at abc1234', failed: false },
      { title: 'Break', result: 'failed: nope', failed: true },
    ]);
    expect(events.find((event) => event.kind === 'artifact.produced')).toMatchObject({ parentSpanId: null });
  });

  it('keeps the output of a failed command and of one that is not a read, and drops a successful read', async () => {
    await seed('E-1');
    const step = probe('commit', async (ctx) => {
      await git(['-C', repo, 'rev-parse', '--git-dir']);
      await git(['-C', repo, 'rev-parse', 'no-such-ref']).catch(() => undefined);
      await git(['-C', repo, 'config', '--list']);
      return finished(ctx);
    });
    await step.execute('E-1');
    const ends = (await eventsOf('E-1')).filter((event) => event.kind === 'command.finished');
    expect(ends[0]).toMatchObject({ exitCode: 0, output: null });
    expect(ends[1]).toMatchObject({ exitCode: 128, output: expect.stringContaining('no-such-ref') });
    expect(ends[2]).toMatchObject({ exitCode: 0, output: expect.stringContaining('core.') });
  });

  it('writes the tools and the messages of an agent as its stream arrives, before it finishes', async () => {
    await seed('E-1');
    const stream = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(700) }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'a.ts' }] } },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');
    golden.app
      .get<{ run: jest.Mock }>(AGENT_RUNNER)
      .run.mockImplementationOnce((input: { onOutput: (chunk: string) => void }) => {
        input.onOutput(`${stream}\n`);
        return Promise.resolve(result('summary:\n- ok\nquestions:\n- none'));
      });
    const step = new ResearchStep(
      new StepKernel(
        golden.runs,
        golden.documents,
        golden.visits,
        golden.flows,
        golden.clock,
        golden.config,
        golden.stepEvents,
      ),
      golden.sandbox,
      golden.launcher,
    );
    await step.execute('E-1');
    const events = await eventsOf('E-1');
    const kinds = events.map((event) => event.kind);
    const launched = kinds.indexOf('agent.launched');
    expect(kinds.slice(launched, launched + 4)).toEqual([
      'agent.launched',
      'agent.message',
      'agent.tool',
      'agent.finished',
    ]);
    expect(events[launched + 1]).toMatchObject({ chars: 700, text: 'x'.repeat(600) });
    expect(events[launched + 2]).toMatchObject({ tool: 'shell', target: 'ls', status: 'ok', resultLine: 'exit 0' });
  });

  it('records the repeated command of a looping agent and fails the step', async () => {
    await seed('E-1');
    const call = (id: string): string =>
      [
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: id, content: 'Exit code 1\nboom', is_error: true }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n');
    golden.app
      .get<{ run: jest.Mock }>(AGENT_RUNNER)
      .run.mockImplementationOnce((input: { onOutput: (chunk: string) => void }) => {
        input.onOutput(`${Array.from({ length: 8 }, (_, n) => call(`t${n}`)).join('\n')}\n`);
        return Promise.resolve({ ...result(''), killReason: 'loop', exitCode: 1 });
      });
    const step = new ResearchStep(
      new StepKernel(
        golden.runs,
        golden.documents,
        golden.visits,
        golden.flows,
        golden.clock,
        golden.config,
        golden.stepEvents,
      ),
      golden.sandbox,
      golden.launcher,
    );
    await step.execute('E-1').catch(() => undefined);
    const events = await eventsOf('E-1');
    expect(events.filter((event) => event.kind === 'agent.loop_hint')).toMatchObject([
      { command: 'npm test', errorLine: 'boom', count: 4 },
      { command: 'npm test', errorLine: 'boom', count: 8, ended: true },
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'attempt.finished', route: 'failed', summary: 'process killed: loop' });
  });

  it('stores the length of a host suspension that the step did not count', async () => {
    await seed('E-1');
    await probe('commit', (ctx) => {
      recordStepEvent({ kind: 'host.suspended', durationMs: 2_400_000 });
      return Promise.resolve(finished(ctx));
    }).execute('E-1');
    const events = await eventsOf('E-1');
    expect(events.find((event) => event.kind === 'host.suspended')).toMatchObject({ durationMs: 2_400_000 });
  });

  it('stores that a model ran at a lower effort than wanted', async () => {
    await seed('E-1');
    await probe('commit', (ctx) => {
      recordStepEvent({
        kind: 'agent.effort_capped',
        model: 'gpt-6.1-sol',
        level: 'xhigh',
        wanted: 'max',
        text: 'gpt-6.1-sol supports up to xhigh; ran at xhigh instead of max.',
      });
      return Promise.resolve(finished(ctx));
    }).execute('E-1');
    const events = await eventsOf('E-1');
    expect(events.find((event) => event.kind === 'agent.effort_capped')).toMatchObject({
      level: 'xhigh',
      wanted: 'max',
    });
  });

  it('stores the usage limit that moved a launch to another agent', async () => {
    await seed('E-1');
    await probe('commit', (ctx) => {
      recordStepEvent({
        kind: 'agent.limited',
        runtime: 'claude',
        window: '5-hour',
        resetsAt: '2026-11-08T21:50:00.000Z',
        continuedWith: 'codex:gpt-6.1-sol',
        text: 'Claude hit its usage limit (resets 21:50 UTC). Continued with codex:gpt-6.1-sol.',
      });
      return Promise.resolve(finished(ctx));
    }).execute('E-1');
    const events = await eventsOf('E-1');
    expect(events.find((event) => event.kind === 'agent.limited')).toMatchObject({
      runtime: 'claude',
      continuedWith: 'codex:gpt-6.1-sol',
    });
  });

  it('records no artifact and no handoff summary for an external document', async () => {
    await seed('E-1');
    await probe('commit', (ctx) =>
      Promise.resolve({
        ...finished(ctx),
        outputs: [
          { artifact: ARTIFACTS.implementation, value: 'a note' },
          { artifact: ARTIFACTS.log, value: '{"type":"system","subtype":"init"}' },
        ],
      }),
    ).execute('E-1');
    const events = await eventsOf('E-1');
    expect(events.filter((event) => event.kind === 'artifact.produced')).toMatchObject([
      { artifactKind: 'implementation' },
    ]);
    expect(events.find((event) => event.kind === 'handoff.sent')).toMatchObject({
      artifactKinds: ['implementation'],
      summaries: ['a note'],
    });
  });

  it('names the step a pass goes to for next and for jump', async () => {
    await seed('E-1');
    await probe('commit', (ctx) => Promise.resolve(finished(ctx))).execute('E-1');
    await probe('implement', (ctx) =>
      Promise.resolve({
        route: { to: 'jump', step: 'commit' },
        summary: `${ctx.opened.startedAt} jump`,
        outputs: [],
        handoff: 'on',
      }),
    ).execute('E-1');
    const sent = (await eventsOf('E-1')).filter((event) => event.kind === 'handoff.sent');
    expect(sent.map((event) => (event as { targetStep: string }).targetStep)).toEqual(['merge-request', 'commit']);
  });

  it('stores a token in git args as ***', async () => {
    await seed('E-1');
    const step = probe('commit', async (ctx) => {
      await git(['-C', repo, 'remote', 'add', 'origin', 'https://user:ghp_abcDEF123456@host/x.git']);
      return finished(ctx);
    });
    await step.execute('E-1');
    const started = (await eventsOf('E-1')).find((event) => event.kind === 'command.started');
    expect(started).toMatchObject({ args: ['-C', repo, 'remote', 'add', 'origin', 'https://***@host/x.git'] });
  });

  it('writes the error branch of a call, a failed command and the issues sent back', async () => {
    await seed('E-1');
    const step = probe('pipeline', async (ctx) => {
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
      await request(golden.clock, 'https://code.example/api', {}, ctx.calls).catch(() => undefined);
      await git(['-C', repo, 'rev-parse', 'no-such-ref']).catch(() => undefined);
      const issue = issueOf('pipeline', 'job failed', 'lint failed');
      return {
        route: { to: 'return', step: 'implement', issues: [issue] },
        summary: 'sent back',
        outputs: [],
        handoff: 'fix lint',
      };
    });
    await step.execute('E-1');
    const events = await eventsOf('E-1');
    expect(events.find((event) => event.kind === 'http.call')).toMatchObject({ statusCode: null });
    expect(events.find((event) => event.kind === 'command.finished')).toMatchObject({ exitCode: 128 });
    const issue = issueOf('pipeline', 'job failed', 'lint failed');
    expect(events.find((event) => event.kind === 'issue.opened')).toMatchObject({
      issueId: issue.id,
      title: 'job failed',
    });
    expect(events.find((event) => event.kind === 'handoff.sent')).toMatchObject({
      targetStep: 'implement',
      issueIds: [issue.id],
    });
    expect(events.at(-1)).toMatchObject({ kind: 'attempt.finished', route: 'implement' });
  });

  it('records a received handoff once, and its issues resolved by the next pass of the source', async () => {
    await seed('E-1');
    const run = await golden.runs.findRun('E-1');
    const issue = issueOf('pipeline', 'job failed', 'lint failed');
    const sender = probe('pipeline', (ctx) =>
      Promise.resolve({
        route: { to: 'return', step: 'implement', issues: [issue] },
        summary: `${ctx.opened.startedAt} sent back`,
        outputs: [{ artifact: ARTIFACTS.issues, value: [issue] }],
        handoff: 'fix lint',
      }),
    );
    await sender.execute('E-1');
    const kernel = new StepKernel(
      golden.runs,
      golden.documents,
      golden.visits,
      golden.flows,
      golden.clock,
      golden.config,
      golden.stepEvents,
    );
    const receiver = new ReceiverStep('implement', kernel);
    await receiver.execute('E-1');
    await receiver.execute('E-1');
    await probe('pipeline', (ctx) => Promise.resolve(finished(ctx))).execute('E-1');

    const events = await eventsOf('E-1');
    const received = events.filter((event) => event.kind === 'handoff.received');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ step: 'implement', issueIds: [issue.id] });
    expect(events.filter((event) => event.kind === 'issue.opened')).toHaveLength(1);
    expect(events.find((event) => event.kind === 'issue.resolved')).toMatchObject({
      step: 'pipeline',
      issueId: issue.id,
    });
    expect(await golden.stepEvents.openIssues(run?.id ?? 0, 'pipeline')).toEqual([]);
  });

  it('writes an interrupted attempt when the body leaves the visit open', async () => {
    await seed('E-1');
    const step = probe('commit', () => Promise.reject(new VisitLeftOpen({ exitCode: 1, message: 'stopped' })));
    await step.execute('E-1');
    const events = await eventsOf('E-1');
    expect(events.at(-1)).toMatchObject({ kind: 'attempt.interrupted', summary: 'stopped' });
    expect(events.map((event) => event.kind)).not.toContain('attempt.finished');
  });

  it('ends a stopped step blocked with the code STOPPED and an interrupted attempt', async () => {
    await seed('E-1');
    const step = probe('commit', () => Promise.reject(new StepStopped(['demo pipeline 7 https://ci.example/7'])));
    const ended = await step.execute('E-1');
    const run = await golden.runs.findRun('E-1');
    expect(run).toMatchObject({ status: 'blocked', state: 'stopped' });
    expect(JSON.parse(run?.stateReason ?? '{}')).toMatchObject({ code: 'STOPPED' });
    expect(ended.message).toContain('Stop is not a rollback');
    const events = await eventsOf('E-1');
    expect(events.at(-1)).toMatchObject({ kind: 'attempt.interrupted', route: 'stopped' });
    expect(events.at(-1)).toMatchObject({ summary: expect.stringContaining('demo pipeline 7 https://ci.example/7') });
    expect(events.map((event) => event.kind)).not.toContain('attempt.finished');
  });

  it('keeps the events and the seq of two runs that go at once apart', async () => {
    await seed('E-1');
    await seed('E-2');
    const step = (key: string) =>
      probe('commit', async (ctx) => {
        await git(['-C', repo, 'rev-parse', '--git-dir']);
        return finished({ ...ctx, opened: { ...ctx.opened, startedAt: key } });
      });
    await Promise.all([step('E-1').execute('E-1'), step('E-2').execute('E-2')]);
    const [first, second] = [await eventsOf('E-1'), await eventsOf('E-2')];
    expect(first.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(second.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(first.map((event) => event.attemptId)).size).toBe(1);
    expect(new Set(second.map((event) => event.attemptId)).size).toBe(1);
    expect(first[0].attemptId).not.toBe(second[0].attemptId);
    expect(first.at(-1)).toMatchObject({ summary: expect.stringContaining('E-1') });
    expect(second.at(-1)).toMatchObject({ summary: expect.stringContaining('E-2') });
  });

  it('does not fail the step when an event cannot be written', async () => {
    await seed('E-1');
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const broken = Object.create(golden.stepEvents) as StepEventLog;
    broken.append = jest.fn().mockRejectedValue(new Error('disk full'));
    const kernel = new StepKernel(
      golden.runs,
      golden.documents,
      golden.visits,
      golden.flows,
      golden.clock,
      golden.config,
      broken,
    );
    const outcome = await probe('commit', (ctx) => Promise.resolve(finished(ctx)), kernel).execute('E-1');
    expect(outcome.exitCode).toBe(0);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(await eventsOf('E-1')).toEqual([]);
  });
});
