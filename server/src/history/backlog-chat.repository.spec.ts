import { plannerDatabase } from '../pipeline/backlog/planner/planner.spec-helpers';

async function withPlanner(body: (db: Awaited<ReturnType<typeof plannerDatabase>>) => Promise<void>): Promise<void> {
  const db = await plannerDatabase();
  try {
    await body(db);
  } finally {
    await db.close();
  }
}

function turn(backlogId: number, turnKey: string, status: 'running' | 'applied' | 'done' | 'failed' | 'waiting') {
  return { backlogId, turnKey, status, reason: '', nextTryAt: null, createdAt: '2026-11-12T10:00:00Z' };
}

describe('BacklogChatRepository', () => {
  it('writes a message once per key', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      const file = { id: 'a'.repeat(32), name: 'shot.png', size: 3 };
      expect(await db.chat.addPersonMessage(id, 'plan it', 'm1', [file])).toMatchObject({
        author: 'person',
        text: 'plan it',
        attachments: [file],
      });
      expect(await db.chat.addPersonMessage(id, 'plan it again', 'm1', [])).toBeNull();
      const { messages } = await db.chat.lastMessages(id, 10);
      expect(messages.map((message) => message.text)).toEqual(['plan it']);
    }));

  it('reads a stored message back with its files, and every other message with none', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      const file = { id: 'b'.repeat(32), name: 'shot.png', size: 3 };
      await db.chat.addPersonMessage(id, 'with file', 'm1', [file]);
      await db.chat.addPersonMessage(id, 'plain', 'm2', []);
      await db.backlogs.transaction(async (writers) => {
        await writers.addMessage({ ...planned(id), messageKey: 'p1' });
      });

      const { messages } = await db.chat.lastMessages(id, 10);
      expect(messages.map((message) => message.attachments)).toEqual([[file], [], []]);
      await db.chat.takeInto(id, 'turn-1');
      expect((await db.chat.itemsOfTurn('turn-1')).messages.map((message) => message.attachments)).toEqual([
        [file],
        [],
      ]);
    }));

  it('gives every waiting message and event to one turn together', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.addMessage(id, 'first');
      await db.addMessage(id, 'second');
      await db.addEvent(id, 'task-merged:a');
      const taken = await db.chat.takeInto(id, 'turn-1');
      expect(taken.messages.map((message) => message.text)).toEqual(['first', 'second']);
      expect(taken.events.map((event) => event.eventKey)).toEqual(['task-merged:a']);
      expect((await db.chat.waitingItems(id)).messages).toEqual([]);
      expect(await db.chat.backlogsWithWaitingWork()).toEqual([]);
      expect((await db.chat.itemsOfTurn('turn-1')).events).toHaveLength(1);
    }));

  it('takes what came after a first take into the same turn and keeps what it took before', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.addMessage(id, 'first');
      await db.chat.takeInto(id, 'turn-1');
      await db.addMessage(id, 'second');
      await db.addEvent(id, 'task-merged:a');

      const taken = await db.chat.takeInto(id, 'turn-1');

      expect(taken.messages.map((message) => message.text)).toEqual(['first', 'second']);
      expect(taken.events.map((event) => event.eventKey)).toEqual(['task-merged:a']);
      expect(await db.chat.backlogsWithWaitingWork()).toEqual([]);
    }));

  it('does not wake a backlog for the record of an action, and gives it to no turn', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.addEvent(id, 'action:1', 'action', { action: 'add tasks' });
      expect(await db.chat.backlogsWithWaitingWork()).toEqual([]);
      expect((await db.chat.waitingItems(id)).events).toEqual([]);
      expect((await db.chat.takeInto(id, 'turn-1')).events).toEqual([]);
    }));

  it('keeps the items of a failed turn with it until Resume, and takes only the new ones', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.addMessage(id, 'first');
      await db.addEvent(id, 'task-merged:a');
      await db.chat.takeInto(id, 'turn-1');
      await db.chat.saveTurn(turn(id, 'turn-1', 'failed'));
      await db.addMessage(id, 'second');

      const waiting = await db.chat.waitingItems(id);
      expect(waiting.messages.map((message) => message.text)).toEqual(['second']);
      expect(waiting.events).toEqual([]);
      expect(await db.chat.backlogsWithWaitingWork()).toEqual([id]);

      const taken = await db.chat.takeInto(id, 'turn-2');
      expect(taken.messages.map((message) => message.text)).toEqual(['second']);
      const kept = await db.chat.itemsOfTurn('turn-1');
      expect(kept.messages.map((message) => message.text)).toEqual(['first']);
      expect(kept.events).toHaveLength(1);
    }));

  it('gives the items of the named failed turns to the new turn together with the waiting ones', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.addMessage(id, 'first');
      await db.addEvent(id, 'task-merged:a');
      await db.chat.takeInto(id, 'turn-1');
      await db.chat.saveTurn(turn(id, 'turn-1', 'failed'));
      await db.addMessage(id, 'second');

      const waiting = await db.chat.waitingItems(id, ['turn-1']);
      expect(waiting.messages.map((message) => message.text)).toEqual(['first', 'second']);
      expect(waiting.events.map((event) => event.eventKey)).toEqual(['task-merged:a']);
      expect(await db.chat.backlogsWithWaitingWork(['turn-1'])).toEqual([id]);

      const taken = await db.chat.takeInto(id, 'turn-2', ['turn-1']);
      expect(taken.messages.map((message) => message.text)).toEqual(['first', 'second']);
      expect(taken.events.map((event) => event.eventKey)).toEqual(['task-merged:a']);
      const kept = await db.chat.itemsOfTurn('turn-1');
      expect(kept.messages).toEqual([]);
      expect(kept.events).toEqual([]);
    }));

  it('reads the last messages in order with the count of older ones', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      for (const text of ['one', 'two', 'three', 'four']) await db.addMessage(id, text);
      const recent = await db.chat.lastMessages(id, 2);
      expect(recent.messages.map((message) => message.text)).toEqual(['three', 'four']);
      expect(recent.older).toBe(2);
    }));

  it('lists turns by status and finds a turn by its key', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.chat.saveTurn(turn(id, 'a', 'running'));
      const saved = await db.chat.saveTurn(turn(id, 'b', 'done'));
      await db.chat.saveTurn({ ...turn(id, 'c', 'waiting'), nextTryAt: '2026-11-12T11:00:00Z' });
      await db.chat.saveTurn({ ...saved, status: 'applied' });
      const open = await db.chat.turnsByStatus(['running', 'applied', 'waiting']);
      expect(open.map((row) => row.turnKey)).toEqual(['a', 'b', 'c']);
      expect((await db.chat.findTurn('c'))?.nextTryAt).toBe('2026-11-12T11:00:00Z');
      expect(await db.chat.findTurn('none')).toBeNull();
    }));

  it('lists the turns of one backlog only', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.chat.saveTurn(turn(id, 'a', 'done'));
      await db.chat.saveTurn(turn(id + 1, 'other', 'done'));
      await db.chat.saveTurn(turn(id, 'b', 'failed'));
      expect((await db.chat.turnsOf(id)).map((row) => row.turnKey)).toEqual(['a', 'b']);
    }));

  it('gives the seen state of the newest turn that has one', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      expect(await db.chat.lastSeenState(id)).toBeNull();
      await db.chat.saveTurn({ ...turn(id, 'a', 'done'), seenState: 'first' });
      await db.chat.saveTurn({ ...turn(id, 'b', 'done'), seenState: 'second' });
      await db.chat.saveTurn({ ...turn(id + 1, 'other', 'done'), seenState: 'other backlog' });
      await db.chat.saveTurn(turn(id, 'c', 'failed'));
      expect((await db.chat.turnsOf(id)).map((row) => row.seenState)).toEqual(['first', 'second', null]);
      expect(await db.chat.lastSeenState(id)).toBe('second');
    }));

  it('keeps a merged task unhandled until its turn is done', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.addEvent(id, 'task-merged:a', 'task-merged', { slug: 'a' });
      await db.addEvent(id, 'task-merged:b', 'task-merged', { slug: 'b' });
      expect(await db.chat.unhandledMergedSlugs(id)).toEqual(['a', 'b']);

      await db.chat.takeInto(id, 'turn-1');
      const saved = await db.chat.saveTurn(turn(id, 'turn-1', 'applied'));
      expect(await db.chat.unhandledMergedSlugs(id)).toEqual(['a', 'b']);

      await db.chat.saveTurn({ ...saved, status: 'done' });
      expect(await db.chat.unhandledMergedSlugs(id)).toEqual([]);
    }));

  it('lets reads inside a transaction see its writes', () =>
    withPlanner(async (db) => {
      const id = await db.addBacklog();
      await db.backlogs.transaction(async (writers) => {
        const milestone = await writers.saveMilestone({
          backlogId: id,
          number: 1,
          title: 'First',
          goal: 'g',
          status: 'proposed',
          createdAt: db.clock.iso(),
        });
        await writers.saveRequirement({ milestoneId: milestone.id as number, ref: 'M1.R1', text: 't', status: 'open' });
        await writers.addDecision({ backlogId: id, text: 'use x', who: 'planner', createdAt: db.clock.iso() });
        expect((await writers.milestones(id)).map((row) => row.title)).toEqual(['First']);
        expect((await writers.requirements(id)).map((row) => row.ref)).toEqual(['M1.R1']);
        expect((await writers.decisions(id)).map((row) => row.text)).toEqual(['use x']);
        expect((await writers.findBacklog('alpha'))?.id).toBe(id);
        expect(await writers.tasks(id)).toEqual([]);
        expect(await writers.addMessage({ ...planned(id), messageKey: 'p1' })).toBe(true);
        expect(await writers.addMessage({ ...planned(id), messageKey: 'p1' })).toBe(false);
      });
      expect((await db.chat.lastMessages(id, 5)).messages.map((message) => message.author)).toEqual(['planner']);
    }));
});

function planned(backlogId: number) {
  return {
    backlogId,
    messageKey: '',
    author: 'planner' as const,
    kind: 'message' as const,
    text: 'here is a plan',
    proposes: 1,
    turn: 'turn-1',
    attachments: [],
    createdAt: '2026-11-12T10:00:00Z',
  };
}
