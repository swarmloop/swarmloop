import 'reflect-metadata';
import { join } from 'path';
import { BacklogChatService } from '../../api/backlog-chat.service';
import { PlanChatService } from '../../api/plan-chat.service';
import { BacklogChatRepository } from '../../history/backlog-chat.repository';
import { runTaskStatus } from '../../contract/subtask';
import { storedState, writeRunState } from '../../history/run-state';
import { REASON } from '../../contract/reason-words';
import { storeRun } from '../store-run.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { BacklogRepository } from '../../history/backlog.repository';
import { remoteProject } from '../../integrations/code-host/remote-project';
import { BacklogPlanner } from '../../pipeline/backlog/planner/backlog-planner';
import { FAKE_MODEL_KEY } from '../env.spec-helpers';
import { createFlowHarness } from '../flow-harness';
import { BlockAgentRunner, resultAnswer, type ScriptedAnswer } from '../result-answer';
import { git } from '../runs.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const OWNER = 'owner';
const BACKLOG = 'shop';
/** Longer than the window of the usage limit the waiting turn is held by. */
const PAST_THE_LIMIT = 6 * 60 * 60_000;

/** Two runtimes, so a usage limit on one is tried on the other and then the turn waits. */
const ENV = { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY, AGENTS_BACKLOG_PLAN: 'claude:m-claude,codex:m-codex' };

describe('a planner turn whose next try comes while other work of its backlog runs', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  /** The prompts of the planner turns, in order. */
  let prompts: string[];
  /** The next answers of the planner turns; an empty turn when none is left. */
  let answers: ScriptedAnswer[];
  /** What the planner's command to the run does: it fails once, then waits for `release`. */
  let sending: () => Promise<void>;

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    prompts = [];
    answers = [];
    const blocks = new BlockAgentRunner();
    const base = blocks.run.bind(blocks);
    blocks.run = (input) => {
      if (input.step !== 'backlog-plan') return base(input);
      prompts.push(input.prompt ?? '');
      const next = answers.shift();
      return next ? new BlockAgentRunner({ 'backlog-plan': [next] }).run(input) : base(input);
    };
    flow = await createFlowHarness('b03', { env: ENV, realImplement: false, realReview: false, blocks });
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
    remoteProject(url);
    flow.host.defaultBranchPasses();
    sending = () => Promise.resolve();
    jest.spyOn(PlanChatService.prototype, 'sendToPlanner').mockImplementation(() => sending() as never);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    await flow.close();
  });

  const turns = () =>
    flow.app.app.get(BacklogChatRepository).turnsByStatus(['running', 'applied', 'done', 'failed', 'waiting']);

  /** A backlog with a task whose run exists, as the scheduler starts it. */
  async function startedTask(): Promise<string> {
    const { actions, scheduler } = flow.backlog();
    await actions.createBacklog(OWNER, { name: BACKLOG, repositories: ['demo'], mergeMode: 'green' });
    await actions.proposeMilestone(OWNER, BACKLOG, { title: 'Ship the shop', goal: 'Customers can order.' });
    await actions.addRequirements(OWNER, BACKLOG, 1, { texts: ['Orders can be placed'] });
    await actions.addTasks(OWNER, BACKLOG, [
      {
        id: 'a',
        title: 'Task a',
        description: 'Do a.',
        repositories: ['demo'],
        files: ['src/a.ts'],
        proof: ['a.spec.ts'],
        milestone: 1,
        covers: ['M1.R1'],
        depends: [],
      },
    ]);
    await actions.runMilestone(OWNER, BACKLOG, 1);
    await scheduler.tick();
    const id = (await flow.app.app.get(BacklogRepository).findBacklog(BACKLOG))!.id as number;
    const runKey = (await flow.app.app.get(BacklogRepository).tasks(id))[0].runKey as string;
    await flow.app.pipeline.whenIdle(runKey);
    // The run stands blocked at checks, as the planner's own specs leave a task whose run no step drives.
    const runs = flow.app.app.get(RunRepository);
    const run = (await runs.findRun(runKey))!;
    writeRunState(run, {
      status: 'blocked',
      currentStep: 'checks',
      reason: { code: REASON.loopLimit, message: 'checks ran 3 times (MAX_RETURNS)' },
    });
    await storeRun(runs, run);
    const backlogs = flow.app.app.get(BacklogRepository);
    const [task] = await backlogs.tasks(id);
    await backlogs.saveTask({
      ...task,
      status: runTaskStatus({ state: storedState(run).state, currentStep: run.currentStep }),
    });
    return runKey;
  }

  const say = (text: string) => flow.app.app.get(BacklogChatService).post(OWNER, BACKLOG, text, `m-${text}`);

  /**
   * An applied turn whose sending failed, and after it a turn that waits for a usage limit to end, with its timer set.
   * From here the next command to the run is held until the returned function is called.
   */
  async function appliedThenWaiting(): Promise<() => void> {
    const runKey = await startedTask();
    const hi = { action: 'planChat', run: runKey, message: 'hi', reason: 'tell it' };
    let fail = true;
    sending = () => {
      if (!fail) return Promise.resolve();
      fail = false;
      return Promise.reject(new Error('socket closed'));
    };
    answers = [
      { text: resultAnswer('On it.', { say: 'On it.', actions: [hi] }) },
      { limit: { window: '5-hour' } },
      { limit: { window: '5-hour' } },
    ];
    await say('tell it to say hi');
    await flow.app.app.get(BacklogPlanner).whenIdle();
    expect((await turns()).map((turn) => turn.status)).toEqual(['applied']);

    flow.app.clock.advance(1000);
    await say('second message');
    await flow.app.app.get(BacklogPlanner).whenIdle();
    expect((await turns()).map((turn) => turn.status)).toEqual(['applied', 'waiting']);

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sending = () => gate;
    return release;
  }

  /** The waiting turn ran once after the resend, with its message in the planner's prompt, and the system settled. */
  async function expectWaitingTurnRan(launchesBefore: number): Promise<void> {
    expect((await turns()).map((turn) => turn.status)).toEqual(['done', 'done']);
    const after = prompts.slice(launchesBefore);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain('second message');
    await settle(flow.app);
    await assertSettled(flow.app);
  }

  it('runs once after the resend that a restart started, when the resend is held open past the next try', async () => {
    const release = await appliedThenWaiting();
    const launchesBefore = prompts.length;
    flow.app.clock.advance(PAST_THE_LIMIT);
    await flow.restart();
    // The new process starts its clock at the epoch, so the timer of the waiting turn counts the whole wait.
    await jest.advanceTimersByTimeAsync(PAST_THE_LIMIT);
    release();
    await flow.app.app.get(BacklogPlanner).whenIdle();

    await expectWaitingTurnRan(launchesBefore);
  });

  it('runs once after the resend that Resume started, when the resend is held open past the next try', async () => {
    const release = await appliedThenWaiting();
    const launchesBefore = prompts.length;
    await flow.app.app.get(BacklogPlanner).resume(BACKLOG);
    flow.app.clock.advance(PAST_THE_LIMIT);
    await jest.advanceTimersByTimeAsync(PAST_THE_LIMIT);
    release();
    await flow.app.app.get(BacklogPlanner).whenIdle();

    await expectWaitingTurnRan(launchesBefore);
  });
});
