import 'reflect-metadata';
import { PlanChatService } from '../../api/plan-chat.service';
import { BacklogChatRepository } from '../../history/backlog-chat.repository';
import { BacklogPlanner } from '../../pipeline/backlog/planner/backlog-planner';
import { resultAnswer } from '../result-answer';
import { BACKLOG, bootPlanner, LIMIT, PAST_THE_LIMIT, type PlannerBoot } from './planner-faults.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

describe('a planner turn whose next try comes while other work of its backlog runs', () => {
  let boot: PlannerBoot;
  /** What the planner's command to the run does: it fails once, then waits for `release`. */
  let sending: () => Promise<void>;

  beforeEach(async () => {
    boot = await bootPlanner();
    sending = () => Promise.resolve();
    jest.spyOn(PlanChatService.prototype, 'sendToPlanner').mockImplementation(() => sending() as never);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    await boot.flow.close();
  });

  const turns = () =>
    boot.flow.app.app.get(BacklogChatRepository).turnsByStatus(['running', 'applied', 'done', 'failed', 'waiting']);

  /**
   * An applied turn whose sending failed, and after it a turn that waits for a usage limit to end, with its timer set.
   * From here the next command to the run is held until the returned function is called.
   */
  async function appliedThenWaiting(): Promise<() => void> {
    const runKey = await boot.blockedTask();
    const hi = { action: 'planChat', run: runKey, message: 'hi', reason: 'tell it' };
    let fail = true;
    sending = () => {
      if (!fail) return Promise.resolve();
      fail = false;
      return Promise.reject(new Error('socket closed'));
    };
    boot.answers.push({ text: resultAnswer('On it.', { say: 'On it.', actions: [hi] }) }, LIMIT, LIMIT);
    await boot.say('tell it to say hi');
    await boot.idle();
    expect((await turns()).map((turn) => turn.status)).toEqual(['applied']);

    boot.flow.app.clock.advance(1000);
    await boot.say('second message');
    await boot.idle();
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
    const after = boot.prompts.slice(launchesBefore);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain('second message');
    await settle(boot.flow.app);
    await assertSettled(boot.flow.app);
  }

  it('runs once after the resend that a restart started, when the resend is held open past the next try', async () => {
    const release = await appliedThenWaiting();
    const launchesBefore = boot.prompts.length;
    boot.flow.app.clock.advance(PAST_THE_LIMIT);
    await boot.flow.restart();
    // The new process starts its clock at the epoch, so the timer of the waiting turn counts the whole wait.
    await jest.advanceTimersByTimeAsync(PAST_THE_LIMIT);
    release();
    await boot.idle();

    await expectWaitingTurnRan(launchesBefore);
  });

  it('runs once after the resend that Resume started, when the resend is held open past the next try', async () => {
    const release = await appliedThenWaiting();
    const launchesBefore = boot.prompts.length;
    await boot.flow.app.app.get(BacklogPlanner).resume(BACKLOG);
    boot.flow.app.clock.advance(PAST_THE_LIMIT);
    await jest.advanceTimersByTimeAsync(PAST_THE_LIMIT);
    release();
    await boot.idle();

    await expectWaitingTurnRan(launchesBefore);
  });
});
