import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { RunQueriesService } from '../api/run-queries.service';
import { ERROR_CODES } from '../contract/error-codes';
import { REASON } from '../contract/run-state';
import type { Subtask } from '../contract/subtask';
import { AgentCallRepository } from '../history/agent-call.repository';
import { DocumentRepository } from '../history/document.repository';
import { StepStatEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { storedState, writeRunState } from '../history/run-state';
import { VisitStartRepository } from '../history/visit-start.repository';
import { CommandService } from '../pipeline/command.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { PERSON_RESUME } from '../pipeline/resume-sender';
import { installScripts } from '../pipeline/run-driver.spec-helpers';
import { StartGate } from '../pipeline/start-gate';
import { SubtaskPort } from '../pipeline/subtask-port';
import { readVisitInput } from '../steps/shared/visit-input';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { renderNeeds } from '../steps/shared/needs';
import type { Step, StepSnapshot } from '../steps/step';
import type { StepOptions } from '../core/pipeline-result';
import { StepRegistry } from '../steps/step.registry';
import type { StepName } from '../contract/steps';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { loggedCall, save } from './runs.spec-helpers';

const KEY = 'PROJ-480';
const TASK = `${KEY}-a`;
const WORDS = 'I cannot decide which retry policy wins; b has merged and says nothing about it.';
const DECISION = 'Keep the policy in b.';

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

/** The 21.11 loop: a subtask asks a decision as a need on a sibling that is already merged, and its agent writes the same need on every visit. */
describe('a subtask that keeps writing the same need on a merged sibling', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let visits: () => number;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const child = async () => (await runs().findRun(TASK))!;
  const view = () => flow.app.app.get(RunQueriesService).flow(KEY);

  /** Waits until no command and no driver of the epic or the task is left running. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await flow.app.app.get(CommandService).idle();
      await flow.app.pipeline.whenIdle(KEY);
      await flow.app.pipeline.whenIdle(TASK);
    }
  }

  /** The task runs its own steps: its agent writes the same need on b at every visit. The epic's steps stay the real ones. */
  function fakeAgent(): void {
    const registry = flow.app.app.get<{ get(name: StepName): Step | null }>(StepRegistry);
    const real = registry.get('implement')!;
    const steps = installScripts(
      flow.app,
      {
        implement: async (_visit, ctx) => {
          await ctx.write(ARTIFACTS.needs, renderNeeds([{ id: 'b', what: 'which retry policy wins' }]));
          const now = ctx.clock.iso();
          const call = await loggedCall(flow.app.app.get(AgentCallRepository), {
            model: 'fake',
            startedAt: now,
            finishedAt: now,
            durationMs: 0,
            requestText: 'implement',
            responseText: WORDS,
          });
          return { outcome: 'waiting', exitCode: 0, code: ERROR_CODES.SUBTASK_WAITING, visit: { callIds: [call] } };
        },
      },
      ['implement'],
    );
    const scripted = registry.get('implement')!;
    const others = registry.get.bind(registry);
    const own = (key: string) => key === TASK;
    const pick = (key: string) => (own(key) ? scripted : real);
    registry.get = (name) =>
      name !== 'implement'
        ? others(name)
        : new Proxy(real, {
            get: (target, prop) => {
              if (prop === 'usesModel') return true;
              if (prop === 'execute')
                return (key: string, options: StepOptions, snapshot?: StepSnapshot) =>
                  pick(key).execute(key, options, snapshot);
              if (prop === 'missingInput')
                return (key: string, options: StepOptions) => pick(key).missingInput(key, options);
              const value: unknown = Reflect.get(target, prop, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
    visits = () => steps.get('implement')?.count ?? 0;
    // The task's detached starts reach the real driver; the others of its siblings are only recorded.
    const real_ = PipelineService.prototype.startDetached.bind(flow.app.pipeline);
    jest.spyOn(flow.app.pipeline, 'startDetached').mockImplementation((key, ...rest) => {
      if (key === KEY || key === TASK) return real_(key, ...rest);
      flow.launched.push(key);
      return Promise.resolve({ exitCode: 0, message: `${key} started` });
    });
  }

  /** b merged at some time, then the epic's pass saw it; the task waits at implement with its worktree folder in place. */
  async function seed(): Promise<void> {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await storeRun(runs(), parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('b')])}\n`);
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
    const merged = (await runs().findRun(`${KEY}-b`))!;
    await documents().putDocument(merged, 'requirements', requirements);
    await documents().putDocument(merged, 'repos', 'demo\n');
    const record = {
      project: 'demo',
      iid: 1,
      url: 'https://code.example/demo/1',
      draft: false,
      summary: 'adds the retry policy',
    };
    await documents().putDocument(merged, 'merge_request', renderMergeRequest([record]));
    writeRunState(merged, { status: 'done', currentStep: 'done' });
    await storeRun(runs(), merged);
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
    const waiting = await child();
    await documents().putDocument(waiting, 'requirements', requirements);
    await documents().putDocument(waiting, 'repos', 'demo\n');
    writeRunState(waiting, { status: 'waiting', currentStep: 'implement' });
    await storeRun(runs(), waiting);
    mkdirSync(join(flow.app.root, 'worktrees', TASK), { recursive: true });
    flow.app.clock.advance(60_000);
  }

  const starts = async () =>
    (await flow.app.app.get(VisitStartRepository).forRun((await child()).id)).map((row) => row);

  it('starts the task once on each input, asks the epic planner once, and ends with the question at the person', async () => {
    await seed();
    fakeAgent();
    const askAbout = jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(DECISION);

    await flow.app.app.get(CommandService).submit('resume', TASK, { ...PERSON_RESUME });
    await settle();
    await flow.app.pipeline.step('implement', KEY);
    await settle();
    await flow.app.pipeline.step('implement', KEY);
    await settle();

    expect(askAbout).toHaveBeenCalledTimes(1);
    const rows = await starts();
    expect(rows.map((row) => [row.startedBy, row.level])).toEqual([
      ['person', null],
      ['planner', 1],
    ]);
    expect(new Set(rows.map((row) => row.inputDigest)).size).toBe(rows.length);
    expect(visits()).toBe(2);
    const asked = await view();
    expect(asked.items).toHaveLength(1);
    expect(asked.items[0].label.startsWith('Subtask a asks:')).toBe(true);
    expect(asked.stateReason?.code).toBe('NEEDS_ANSWERS');
    await assertInvariants(flow.app);
  });

  it('does not start the task again on the input of its last visit, shows why, and puts the last words to the person', async () => {
    await seed();
    fakeAgent();
    jest.spyOn(flow.app.app.get(SubtaskPort), 'askAbout').mockResolvedValue(null);
    await flow.app.app.get(CommandService).submit('resume', TASK, { ...PERSON_RESUME });
    await settle();
    const before = visits();
    const run = await child();
    const shown: (string | undefined)[] = [];
    const port = flow.app.app.get(SubtaskPort);
    const askUp = port.askUp.bind(port);
    jest.spyOn(port, 'askUp').mockImplementation(async (asking, question, level) => {
      shown.push(storedState((await runs().findRun(asking.key))!).reason?.message);
      return askUp(asking, question, level);
    });

    await flow.app.app.get(StartGate).resume(run, { by: 'machine', event: 'port-wake' });
    await settle();

    expect(visits()).toBe(before);
    expect(shown[0]).toBe('Not started again: same input as visit 1; asked the planner of this run');
    const asked = await view();
    const head = 'Subtask a asks: Not started again: same input as visit 1; asked the person who started the run.';
    expect(asked.items.map((item) => item.label.startsWith(head))).toContain(true);
    expect(asked.items.find((item) => item.label.startsWith(head))?.label).toContain(WORDS);
    expect(storedState(await child()).reason?.code).not.toBe(REASON.stopped);
    await assertInvariants(flow.app);
  });

  it("runs the epic's split pass when the machine wakes it blocked SUBTASK_BLOCKED, with no refusal and no question", async () => {
    await seed();
    fakeAgent();
    const parent = (await runs().findRun(KEY))!;
    const worktrees = join(flow.app.root, 'worktrees', KEY);
    mkdirSync(worktrees, { recursive: true });
    // The epic's last visit ended on the input it has now: an agent step would be refused as the same input.
    const digest = await readVisitInput({ documents: documents(), worktrees }, parent, 'implement', '');
    const now = new Date().toISOString();
    await flow.app.app.get(VisitStartRepository).note({
      runId: parent.id,
      step: 'implement',
      attemptId: 'epic-1',
      startedBy: 'machine',
      level: null,
      inputDigest: digest,
      startReason: null,
      rerunUnfinished: false,
      createdAt: now,
    });
    await flow.app.app.get(VisitRepository).saveStat(
      Object.assign(new StepStatEntity(), {
        runId: parent.id,
        step: 'implement',
        attempt: 1,
        attemptId: 'epic-1',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: 'waiting',
      }),
    );
    writeRunState(parent, {
      status: 'blocked',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SUBTASK_BLOCKED, message: 'a task is blocked' },
    });
    await storeRun(runs(), parent);

    const seen = await flow.app.app.get(StartGate).admit(KEY, 'implement', { startBy: 'machine' });

    expect(seen).toMatchObject({ kind: 'admitted', start: { agent: false } });
    expect(storedState((await runs().findRun(KEY))!).reason?.code).not.toBe(REASON.sameInput);
    await assertInvariants(flow.app);
  });
});
