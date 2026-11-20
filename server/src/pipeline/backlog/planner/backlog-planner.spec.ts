import type { BacklogTurnAction } from '../../../agent-result/definitions/backlog-turn';
import { plannerTurnsHarness } from './planner-turns.spec-helpers';
import { turnResult } from './planner-scenarios.spec-helpers';

type Harness = Awaited<ReturnType<typeof plannerTurnsHarness>>;

async function withTurns(body: (harness: Harness) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const harness = await plannerTurnsHarness(env);
  try {
    await body(harness);
  } finally {
    jest.useRealTimers();
    await harness.close();
  }
}

/** A backlog of the owner `ada` over the repository web, with a green main. */
async function backlogOf(h: Harness): Promise<number> {
  h.setMain('web');
  return (await h.seedBacklog('one')).id as number;
}

const addTask = (id: string, extra: object = {}): BacklogTurnAction => ({
  action: 'addTasks',
  tasks: [{ id, title: id, description: `Do ${id}`, repositories: ['web'], ...extra }],
});

async function launched(h: Harness, count: number): Promise<void> {
  for (let turn = 0; turn < 100_000 && h.agent.launches.length < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(h.agent.launches.length).toBeGreaterThanOrEqual(count);
}

describe('BacklogPlanner', () => {
  it('answers a message with a proposed milestone, starts nothing before the owner runs it, and starts its tasks after', () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      h.agent.script = [
        turnResult(
          'I propose M1: search. Run it?',
          { action: 'proposeMilestone', title: 'Search', goal: 'Find things' },
          { action: 'addRequirements', milestone: 1, texts: ['A person finds an item'] },
          addTask('search', { milestone: 1, covers: ['M1.R1'] }),
        ),
      ];
      await h.say(id, 'plan search for me');
      await h.planner.whenIdle();

      expect(await h.lines(id)).toEqual(['person: plan search for me', 'planner: I propose M1: search. Run it?']);
      expect((await h.chat.lastMessages(id, 10)).messages.map((message) => message.proposes)).toEqual([null, 1]);
      await h.tick();
      await h.planner.whenIdle();
      expect(h.started()).toEqual([]);
      expect(h.agent.launches).toHaveLength(1);

      await h.actions.runMilestone('ada', 'one', 1);
      await h.tick();
      expect(h.started()).toEqual(['search']);
      expect(h.shown.some((entry) => entry.message?.proposes === 1)).toBe(true);
      expect(h.shown.at(-1)?.turn).toMatchObject({ status: 'done' });
    }));

  it('launches nothing and reads no host for a backlog with no message and no event', () =>
    withTurns(async (h) => {
      await h.seedBacklog('one');
      await h.tick();
      await h.planner.whenIdle();
      expect(h.agent.launches).toEqual([]);
      expect(h.workspace.opened).toEqual([]);
    }));

  it('takes everything that came during a turn together in one next turn', () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      let release = (): void => undefined;
      h.agent.gate = new Promise<void>((resolve) => (release = resolve));
      await h.say(id, 'first');
      await launched(h, 1);
      await h.say(id, 'second');
      await h.backlogs.recordEvent(id, 'main-red:web:abc', 'main-red', { repository: 'web', head: 'abc' });
      await h.say(id, 'third');
      h.agent.gate = null;
      release();
      await h.planner.whenIdle();

      const [first, next] = await h.turnsOf(id);
      expect(h.agent.launches).toHaveLength(2);
      expect((await h.chat.itemsOfTurn(first.turnKey)).messages.map((message) => message.text)).toEqual(['first']);
      const taken = await h.chat.itemsOfTurn(next.turnKey);
      expect(taken.messages.map((message) => message.text)).toEqual(['second', 'third']);
      expect(taken.events.map((event) => event.kind)).toEqual(['main-red']);
      expect((await h.turnsOf(id)).map((turn) => turn.status)).toEqual(['done', 'done']);
    }));

  it('applies the actions of a turn once when the server restarts while its commands go out', () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      const milestone = await h.seedMilestone(id, 1);
      await h.seedTask(id, 'going', { milestoneId: milestone.id, runKey: 'going-1', status: 'running' });
      h.agent.script = [
        turnResult('On it.', addTask('extra', { milestone: 1 }), { action: 'planChat', run: 'going-1', message: 'hi' }),
      ];
      h.failNextSend(new Error('socket closed'));
      await h.say(id, 'tell going to say hi');
      await h.planner.whenIdle();

      const [applied] = await h.turnsOf(id);
      expect(applied.status).toBe('applied');
      expect(h.sent).toEqual([]);
      expect((await h.backlogs.tasks(id)).map((task) => task.slug)).toEqual(['going', 'extra']);

      await h.restart();
      await h.planner.whenIdle();

      expect((await h.turnsOf(id)).map((turn) => turn.status)).toEqual(['done']);
      expect(h.sent).toEqual([
        { command: expect.objectContaining({ type: 'planChat', run: 'going-1' }), key: `${applied.turnKey}-action-1` },
      ]);
      expect((await h.backlogs.tasks(id)).map((task) => task.slug)).toEqual(['going', 'extra']);
      expect(h.agent.launches).toHaveLength(1);
    }));

  it('shows a failed turn with its reason, keeps its events, and runs it again with the same events on Resume', () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      h.agent.script = ['crash'];
      await h.say(id, 'plan something');
      await h.planner.whenIdle();

      const [failed] = await h.turnsOf(id);
      expect(failed.status).toBe('failed');
      expect(failed.reason).toContain("The planner's agent did not finish");
      const lines = await h.lines(id);
      expect(lines[1]).toContain('planner: This turn failed: ');
      expect((await h.chat.lastMessages(id, 10)).messages.map((message) => message.kind)).toEqual([
        'message',
        'failed',
      ]);
      expect(h.shown.filter((entry) => entry.turn).map((entry) => entry.turn?.status)).toEqual(['running', 'failed']);
      expect(h.shown.at(-1)?.turn).toMatchObject({ status: 'failed', reason: failed.reason });
      expect(h.workspace.closed).toEqual([failed.turnKey]);

      await h.tick();
      await h.planner.whenIdle();
      expect(h.agent.launches).toHaveLength(1);

      h.agent.script = [turnResult('Here is the plan.')];
      await h.planner.resume('one');
      await h.planner.whenIdle();
      expect((await h.turnsOf(id)).map((turn) => [turn.turnKey, turn.status])).toEqual([[failed.turnKey, 'done']]);
      expect((await h.chat.itemsOfTurn(failed.turnKey)).messages.map((message) => message.text)).toEqual([
        'plan something',
      ]);
      expect((await h.lines(id)).at(-1)).toBe('planner: Here is the plan.');
    }));

  it('keeps the events of a failed turn for Resume when a person writes again, and takes only the new message', () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      await h.backlogs.recordEvent(id, 'task-merged:a', 'task-merged', { slug: 'a' });
      h.agent.script = ['crash'];
      await h.tick();
      await h.planner.whenIdle();
      const [failed] = await h.turnsOf(id);
      expect(failed.status).toBe('failed');

      h.agent.script = [turnResult('Hello.')];
      await h.say(id, 'are you there?');
      await h.planner.whenIdle();
      const turns = await h.turnsOf(id);
      expect(turns.map((turn) => turn.status)).toEqual(['failed', 'done']);
      expect((await h.chat.itemsOfTurn(failed.turnKey)).events).toHaveLength(1);
      expect((await h.chat.itemsOfTurn(turns[1].turnKey)).events).toEqual([]);

      h.agent.script = [turnResult('Read the merge.')];
      await h.planner.resume('one');
      await h.planner.whenIdle();
      expect((await h.turnsOf(id)).map((turn) => turn.status)).toEqual(['done', 'done']);
    }));

  it('does not touch the turns a stop left until the API server starts the planner', () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      await h.chat.addPersonMessage(id, 'plan it', 'm1', []);
      await h.openTurn(id, 'turn-a');
      await h.planner.onModuleDestroy();
      h.restartWithoutStart();
      await h.planner.whenIdle();
      expect(h.agent.launches).toHaveLength(0);
      expect((await h.chat.findTurn('turn-a'))?.status).toBe('running');
    }));

  it('shows the next try of a turn that waits for a usage limit and runs it again then, with the visit it spent recorded', () =>
    withTurns(
      async (h) => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        const id = await backlogOf(h);
        h.agent.script = ['limit', 'limit'];
        await h.say(id, 'plan something');
        await h.planner.whenIdle();

        expect(h.agent.launches.map((launch) => launch.runtime)).toEqual(['claude', 'codex']);
        const [waiting] = await h.turnsOf(id);
        expect(waiting).toMatchObject({ status: 'waiting', tokensIn: 20, tokensOut: 10, usd: 0.5 });
        expect(waiting.nextTryAt).toBe(new Date(h.db.clock.now() + 60 * 60_000).toISOString());
        expect(waiting.reason).toContain('limit');
        expect(h.shown.at(-1)?.turn).toMatchObject({ status: 'waiting', nextTryAt: waiting.nextTryAt });
        expect(await h.lines(id)).toEqual(['person: plan something']);

        h.agent.script = [turnResult('Back at it.')];
        await jest.advanceTimersByTimeAsync(59 * 60_000);
        h.db.clock.advance(59 * 60_000);
        await h.planner.whenIdle();
        expect(h.agent.launches).toHaveLength(2);

        h.db.clock.advance(60_000);
        await jest.advanceTimersByTimeAsync(60_000);
        await h.planner.whenIdle();
        expect(h.agent.launches).toHaveLength(3);
        expect((await h.turnsOf(id)).map((turn) => turn.status)).toEqual(['done']);
        expect((await h.lines(id)).at(-1)).toBe('planner: Back at it.');
      },
      { AGENTS_BACKLOG_PLAN: 'claude:m-claude,codex:m-codex' },
    ));

  it("answers a run's question from a person's reply in the chat at the next turn", () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      const milestone = await h.seedMilestone(id, 1);
      await h.seedTask(id, 'going', { milestoneId: milestone.id, runKey: 'going-1', status: 'running' });
      h.agent.script = [
        turnResult('', { action: 'answerRun', run: 'going-1', answers: [{ id: 'q1', body: 'Use the queue' }] }),
      ];
      await h.say(id, 'going should use the queue');
      await h.planner.whenIdle();
      const [turn] = await h.turnsOf(id);
      expect(h.sent).toEqual([
        {
          command: { type: 'answer', run: 'going-1', answers: [{ id: 'q1', body: 'Use the queue' }] },
          key: `${turn.turnKey}-action-0`,
        },
      ]);
    }));

  it('starts only the fix task of a red main, and the other tasks after the main is green', () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      const milestone = await h.seedMilestone(id, 1);
      await h.seedTask(id, 'feature', { milestoneId: milestone.id });
      h.setMain('web', 'red');
      h.agent.script = [turnResult('Main is red, so I added a fix.', addTask('fix-main', { fixesMain: 'web' }))];
      await h.tick();
      await h.planner.whenIdle();
      expect(h.agent.launches).toHaveLength(1);
      expect(h.started()).toEqual([]);

      await h.tick();
      expect(h.started()).toEqual(['fix-main']);
      expect((await h.task(id, 'feature')).note).toBe('waits for fix-main, which fixes the main of web');
    }));

  it('holds a dependent of a merged task until the planner has read the merge, then starts it', () =>
    withTurns(async (h) => {
      const id = await backlogOf(h);
      const milestone = await h.seedMilestone(id, 1);
      await h.seedTask(id, 'a', { milestoneId: milestone.id, status: 'merged' });
      await h.seedTask(id, 'b', { milestoneId: milestone.id, depends: ['a'] });
      await h.backlogs.recordEvent(id, 'task-merged:a', 'task-merged', { slug: 'a' });
      let release = (): void => undefined;
      h.agent.gate = new Promise<void>((resolve) => (release = resolve));
      await h.tick();
      await launched(h, 1);
      expect(h.started()).toEqual([]);
      expect((await h.task(id, 'b')).note).toBe('waits for the planner to read the merge of a');

      h.agent.gate = null;
      release();
      await h.planner.whenIdle();
      await h.tick();
      expect(h.started()).toEqual(['b']);
    }));
});
