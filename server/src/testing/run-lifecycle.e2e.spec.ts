import { join } from 'path';
import { RunStop } from '../agent/run-stop';
import { writeSession } from '../agent/agent-session';
import type { AgentProcessRunner, AgentRunInput } from '../agent/agent-runner';
import type { AgentRunResult } from '../agent/agent-result';
import type { StepEvent } from '../contract/step-events';
import type { StepName } from '../contract/steps';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { REQUIREMENTS_INPUT, lateInput } from '../steps/agent-step';
import { BaseStep, type StepContext } from '../steps/base-step';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { InputSpec, Issue, StepResult } from '../steps/contract/step-contract';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { issueOf } from '../steps/shared/handoff';
import { StepKernel } from '../steps/step-kernel';
import { createTestApp } from './test-app';

const KEY = 'PROJ-1';
const INPUTS = { requirements: REQUIREMENTS_INPUT, returns: lateInput(ARTIFACTS.issues) } as const satisfies InputSpec;

/** Runs an agent through the launcher, so the session and the context are recorded. */
class ImplementProbe extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'implement';
  readonly inputs = INPUTS;
  readonly outputs = [ARTIFACTS.implementation];
  count = 0;

  constructor(
    kernel: StepKernel,
    private readonly launcher: AgentLauncher,
    private readonly root: string,
    private readonly fresh: (run: number) => boolean,
  ) {
    super(kernel);
  }

  protected async work(_input: unknown, ctx: StepContext): Promise<StepResult> {
    this.count += 1;
    await this.launcher.launch({
      root: this.root,
      run: ctx.opened.run,
      key: KEY,
      step: this.name,
      mode: 'agent',
      model: 'model-1',
      timeLimitMs: 1000,
      prompt: 'Implement it.\n\nRequirements:\nship the field\n\nWhat previous steps did:\n- planned',
      workspace: this.root,
      mounts: [{ hostPath: this.root, containerPath: '/work/demo' }],
      resume: this.fresh(this.count) ? false : undefined,
    });
    return {
      route: { to: 'next' },
      summary: `${ctx.opened.startedAt} implemented`,
      outputs: [{ artifact: ARTIFACTS.implementation, value: 'a note' }],
      // Only the first visit writes a handoff, so a later one is a repeated delivery of the same handoff.
      handoff: this.count === 1 ? 'implemented' : undefined,
    };
  }
}

/** Sends back the issues it is given, then passes. */
class PipelineProbe extends BaseStep<typeof INPUTS> {
  readonly name: StepName = 'pipeline';
  readonly inputs = { requirements: REQUIREMENTS_INPUT } as unknown as typeof INPUTS;
  readonly outputs = [ARTIFACTS.issues];
  issues: Issue[] = [];

  protected work(_input: unknown, ctx: StepContext): Promise<StepResult> {
    const route =
      this.issues.length > 0
        ? { to: 'return' as const, step: 'implement' as const, issues: this.issues }
        : { to: 'next' as const };
    return Promise.resolve({
      route,
      summary: `${ctx.opened.startedAt} pipeline`,
      outputs: this.issues.length > 0 ? [{ artifact: ARTIFACTS.issues, value: this.issues }] : [],
      handoff: this.issues.length > 0 ? 'lint failed' : undefined,
    });
  }
}

describe('a return is one issue in two windows', () => {
  it('records the issue on both sides, once, and reads the same twice', async () => {
    const app = await createTestApp();
    try {
      const fakeAgent = {
        run: async (input: AgentRunInput): Promise<AgentRunResult> => {
          await writeSession(input.sessionFile, 'cursor', {
            chatId: 'chat-1',
            resumed: false,
            completed: true,
            killReason: null,
          });
          return {
            responseText: '',
            chatId: 'chat-1',
            tokensIn: 1,
            tokensOut: 1,
            usd: 0,
            killReason: null,
            exitCode: 0,
            resumed: input.resumeChatId !== null,
            calls: 1,
            samples: [],
            durationMs: 1,
            startedAt: '',
            finishedAt: '',
          };
        },
      };
      const kernel = app.app.get(StepKernel);
      const launcher = new AgentLauncher(
        fakeAgent as unknown as AgentProcessRunner,
        app.app.get(VisitRepository),
        new RunStop(),
      );
      // The second visit starts a new chat.
      const implement = new ImplementProbe(kernel, launcher, join(app.root), (run) => run === 2);
      const pipeline = new PipelineProbe(kernel);
      const run = await app.app.get(RunRepository).begin(KEY, 'prepare');
      run.status = 'waiting';
      run.currentStep = 'implement';
      await app.app.get(RunRepository).saveRun(run);
      await app.app.get(DocumentRepository).putDocument(run, 'requirements', '{"prompt":"ship the field"}\n');

      await implement.execute(KEY);
      const issue = issueOf('pipeline', 'job failed', 'lint failed');
      pipeline.issues = [issue];
      await pipeline.execute(KEY);
      await implement.execute(KEY);
      await implement.execute(KEY);
      pipeline.issues = [];
      await pipeline.execute(KEY);

      const read = async (): Promise<StepEvent[]> =>
        ((await (await fetch(`${app.url}/runs/${KEY}/events?limit=500`)).json()) as { events: StepEvent[] }).events;
      const events = await read();
      const of = <K extends StepEvent['kind']>(kind: K) =>
        events.filter((event): event is Extract<StepEvent, { kind: K }> => event.kind === kind);

      expect(of('issue.opened')).toHaveLength(1);
      const received = of('handoff.received');
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ step: 'implement', issueIds: [issue.id] });
      expect(of('handoff.sent').find((event) => event.step === 'pipeline')).toMatchObject({
        handoffId: received[0].handoffId,
        issueIds: [issue.id],
      });
      expect(of('session.changed').map((event) => [event.session, event.reason])).toEqual([
        ['new chat', 'no stored chat'],
        ['new chat', 'fresh by step policy'],
        ['same chat', null],
      ]);
      expect(of('context.manifest')[0]).toMatchObject({
        sections: [
          { heading: 'prompt', size: expect.any(Number) },
          { heading: 'Requirements', size: expect.any(Number) },
          { heading: 'What previous steps did', size: expect.any(Number) },
        ],
        artifacts: ['/work/demo'],
        cut: [],
      });
      const resolved = of('issue.resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ step: 'pipeline', issueId: issue.id });
      expect(of('issue.opened')[0]).toMatchObject({ issueId: issue.id, title: 'job failed' });

      expect(await read()).toEqual(events);
      for (const step of ['implement', 'pipeline']) {
        const page = (await (await fetch(`${app.url}/runs/${KEY}/events?step=${step}&limit=500`)).json()) as {
          events: StepEvent[];
        };
        expect(page.events).toEqual(events.filter((event) => event.step === step));
      }
    } finally {
      await app.close();
    }
  });
});
