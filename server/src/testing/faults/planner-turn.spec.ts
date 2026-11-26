import 'reflect-metadata';
import { BacklogChatRepository } from '../../history/backlog-chat.repository';
import { BacklogRepository } from '../../history/backlog.repository';
import { BacklogPlanner } from '../../pipeline/backlog/planner/backlog-planner';
import { TurnTakes } from '../../pipeline/backlog/planner/turn-takes';
import {
  BACKLOG,
  bootPlanner,
  LIMIT,
  NO_RESULT,
  PAST_THE_LIMIT,
  says,
  type PlannerBoot,
} from './planner-faults.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

/** How often `text` is read in the prompt. */
const times = (prompt: string, text: string): number => prompt.split(text).length - 1;

describe('a backlog planner turn under faults', () => {
  let boot: PlannerBoot;

  afterEach(async () => {
    jest.useRealTimers();
    await boot.flow.close();
  });

  const planner = () => boot.flow.app.app.get(BacklogPlanner);
  const stateOf = async (text: string) => (await boot.chat()).messages.find((message) => message.text === text)?.state;
  const statuses = async () => (await boot.chat()).turns.map((turn) => turn.status);
  const plannerLines = async () =>
    (await boot.chat()).messages.filter((message) => message.author === 'planner').map((message) => message.text);

  /** A message and an event come while the held turn runs; both are taken into it. */
  async function arrivals(): Promise<void> {
    const backlogId = (await boot.flow.app.app.get(BacklogRepository).findBacklog(BACKLOG))!.id as number;
    await boot.say('note-beta');
    await boot.flow.app.app
      .get(BacklogRepository)
      .recordEvent(backlogId, 'task-merged:late', 'task-merged', { slug: 'late-slug' });
    await boot.flow.backlog().scheduler.tick();
    await boot.flow.app.app.get(TurnTakes).idle();
  }

  describe('a turn that fails', () => {
    it('holds its messages with Resume in the chat, and Resume runs the same turn to its end', async () => {
      boot = await bootPlanner();
      await boot.blockedTask();
      boot.answers.push(NO_RESULT, NO_RESULT, NO_RESULT);
      await boot.say('note-alpha');
      await boot.idle();

      expect(await statuses()).toEqual(['failed']);
      expect((await boot.chat()).messages.map((message) => message.kind)).toContain('failed');
      expect(await stateOf('note-alpha')).toBe('waiting');

      boot.answers.length = 0;
      boot.answers.push(says('Back again.'));
      await planner().resume(BACKLOG);
      await boot.idle();

      expect(await statuses()).toEqual(['done']);
      expect(await stateOf('note-alpha')).toBe('answered');
      expect(await plannerLines()).toContain('Back again.');
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });
  });

  describe('a message and an event that arrive while a turn runs', () => {
    it('are taken into the turn and answered in its one follow-up, which is the answer applied', async () => {
      boot = await bootPlanner();
      await boot.blockedTask();
      boot.answers.push(says('First answer.'), says('Answer with both.'));
      const held = boot.holdNext();
      await boot.say('note-alpha');
      await held.reached;
      await arrivals();

      expect(await stateOf('note-beta')).toBe('read');
      held.release();
      await boot.idle();

      expect(boot.prompts).toHaveLength(2);
      expect(boot.prompts[0]).not.toContain('note-beta');
      expect(boot.prompts[1]).toContain('note-beta');
      expect(boot.prompts[1]).toContain('late-slug');
      expect(await statuses()).toEqual(['done']);
      expect(await plannerLines()).toEqual(['Answer with both.']);
      expect(await stateOf('note-beta')).toBe('answered');
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });

    it('start the next turn when they arrive after the window closed', async () => {
      boot = await bootPlanner();
      await boot.blockedTask();
      boot.answers.push(says('First answer.'), says('Later answer.'));
      await boot.say('note-alpha');
      await boot.idle();
      expect(await statuses()).toEqual(['done']);

      await boot.say('note-later');
      await boot.idle();

      expect(await statuses()).toEqual(['done', 'done']);
      expect(boot.prompts[1]).toContain('note-later');
      expect(await stateOf('note-later')).toBe('answered');
      expect(await plannerLines()).toEqual(['First answer.', 'Later answer.']);
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });
  });

  describe('a turn with its window open that', () => {
    async function takenThenFollowUp(follow: (typeof NO_RESULT)[]): Promise<void> {
      boot = await bootPlanner();
      await boot.blockedTask();
      boot.answers.push(says('First answer.'), ...follow);
      const held = boot.holdNext();
      await boot.say('note-alpha');
      await held.reached;
      await arrivals();
      held.release();
      await boot.idle();
    }

    it('fails passes its taken items to the same turn on Resume, once each', async () => {
      await takenThenFollowUp([NO_RESULT, NO_RESULT, NO_RESULT]);
      expect(await statuses()).toEqual(['failed']);
      expect(await stateOf('note-beta')).toBe('waiting');

      boot.answers.length = 0;
      boot.answers.push(says('Resumed.'));
      await planner().resume(BACKLOG);
      await boot.idle();

      const brief = boot.prompts.at(-1) ?? '';
      expect([times(brief, 'note-alpha'), times(brief, 'note-beta'), times(brief, 'late-slug')]).toEqual([1, 1, 1]);
      expect(await statuses()).toEqual(['done']);
      expect(await stateOf('note-beta')).toBe('answered');
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });

    it('fails passes its taken items to the next turn that a new message starts', async () => {
      await takenThenFollowUp([NO_RESULT, NO_RESULT, NO_RESULT]);
      boot.answers.length = 0;
      boot.answers.push(says('Next turn.'));
      await boot.say('note-gamma');
      await boot.idle();

      const brief = boot.prompts.at(-1) ?? '';
      expect([times(brief, 'note-alpha'), times(brief, 'note-beta'), times(brief, 'note-gamma')]).toEqual([1, 1, 1]);
      expect(await statuses()).toEqual(['failed', 'done']);
      expect(await stateOf('note-beta')).toBe('answered');
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });

    it('waits keeps its taken items, and its next try runs the same turn with them', async () => {
      await takenThenFollowUp([LIMIT, LIMIT]);
      expect(await statuses()).toEqual(['waiting']);
      expect(await stateOf('note-beta')).toBe('waiting');

      boot.answers.length = 0;
      boot.answers.push(says('After the limit.'));
      boot.flow.app.clock.advance(PAST_THE_LIMIT);
      await jest.advanceTimersByTimeAsync(PAST_THE_LIMIT);
      await boot.idle();

      const brief = boot.prompts.at(-1) ?? '';
      expect([times(brief, 'note-alpha'), times(brief, 'note-beta'), times(brief, 'late-slug')]).toEqual([1, 1, 1]);
      expect(await statuses()).toEqual(['done']);
      expect(await plannerLines()).toEqual(['After the limit.']);
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });
  });

  describe('a restart inside a turn', () => {
    it('runs the same turn again under its key with the items it had taken, and ends it', async () => {
      boot = await bootPlanner();
      await boot.blockedTask();
      const backlogId = (await boot.flow.app.app.get(BacklogRepository).findBacklog(BACKLOG))!.id as number;
      // The process died with its turn running: its row is open and holds two messages it had taken.
      const chats = boot.flow.app.app.get(BacklogChatRepository);
      await chats.addPersonMessage(backlogId, 'note-alpha', 'message-one', []);
      await chats.addPersonMessage(backlogId, 'note-beta', 'message-two', []);
      await chats.saveTurn({
        backlogId,
        turnKey: 'turn-dead',
        status: 'running',
        reason: '',
        nextTryAt: null,
        createdAt: boot.flow.app.clock.iso(),
      });
      await chats.takeInto(backlogId, 'turn-dead');

      boot.answers.push(says('After the restart.'));
      await boot.flow.restart();
      await boot.idle();

      const brief = boot.prompts.at(-1) ?? '';
      expect([times(brief, 'note-alpha'), times(brief, 'note-beta')]).toEqual([1, 1]);
      expect(await statuses()).toEqual(['done']);
      expect(await stateOf('note-beta')).toBe('answered');
      expect(await plannerLines()).toEqual(['After the restart.']);
      await settle(boot.flow.app);
      await assertSettled(boot.flow.app);
    });
  });
});
