import { storeRun } from '../../../testing/store-run.spec-helpers';
import { writeRunState, type RunStateChange } from '../../../history/run-state';
import { SUBTASKS_KIND } from '../../../contract/subtask';
import { plannerFacts } from './planner-facts.spec-helpers';
import { BacklogTurnState } from './turn-state';

type Harness = Awaited<ReturnType<typeof plannerFacts>>;

async function withState(body: (h: Harness, state: BacklogTurnState) => Promise<void>): Promise<void> {
  const h = await plannerFacts();
  try {
    await body(h, new BacklogTurnState(h.backlogs, h.chat, h.runs, h.documents, h.eventFacts()));
  } finally {
    await h.close();
  }
}

async function milestone(h: Harness, backlogId: number, number: number, status: 'active' | 'queued') {
  const saved = await h.backlogs.saveMilestone({
    backlogId,
    number,
    title: `M${number}`,
    goal: `goal ${number}`,
    status,
    createdAt: h.clock.iso(),
  });
  return saved.id as number;
}

describe('BacklogTurnState', () => {
  it('reads the backlog, the active milestone with its requirements and tasks, the planned milestones and the items', () =>
    withState(async (h, state) => {
      const id = await h.addBacklog('alpha', ['web', 'api']);
      const active = await milestone(h, id, 1, 'active');
      const queued = await milestone(h, id, 2, 'queued');
      await h.backlogs.saveRequirement({ milestoneId: active, ref: 'M1.R1', text: 'first', status: 'open' });
      await h.backlogs.saveRequirement({ milestoneId: queued, ref: 'M2.R1', text: 'later', status: 'open' });
      await h.addTask(id, 'a', { milestoneId: active, covers: ['M1.R1'], note: 'waits for a green main of web' });
      await h.addTask(id, 'b', { milestoneId: queued });
      await h.addTask(id, 'idea');
      await h.backlogs.addDecision({ backlogId: id, text: 'use sqlite', who: 'owner', createdAt: h.clock.iso() });

      const read = await state.read('alpha', 'turn-1');

      expect(read.backlog).toEqual({ name: 'alpha', repositories: ['web', 'api'], mergeMode: 'green', paused: false });
      expect(read.active).toMatchObject({
        number: 1,
        goal: 'goal 1',
        requirements: [{ ref: 'M1.R1', text: 'first', status: 'open' }],
        tasks: [{ slug: 'a', covers: ['M1.R1'], wait: 'waits for a green main of web', status: 'waiting' }],
      });
      expect(read.planned).toMatchObject([{ number: 2, tasks: [{ slug: 'b' }] }]);
      expect(read.items.map((task) => task.slug)).toEqual(['idea']);
      expect(read.decisions).toMatchObject([{ text: 'use sqlite', who: 'owner' }]);
    }));

  it("reads the subtasks of a task whose run split from the run's stored task list, with the run key", () =>
    withState(async (h, state) => {
      const id = await h.addBacklog();
      const active = await milestone(h, id, 1, 'active');
      await h.addTask(id, 'a', { milestoneId: active, runKey: 'a-1' });
      const list = [
        { id: 's1', title: 'first', description: 'x', depends: [], files: ['a.ts'], proof: '', status: 'merged' },
        { id: 's2', title: 'second', description: 'y', depends: ['s1'], files: ['b.ts'], proof: '' },
      ];
      await h.addRun('a-1', { [SUBTASKS_KIND]: JSON.stringify(list) });

      const [task] = (await state.read('alpha', 'turn-1')).active?.tasks ?? [];

      expect(task).toMatchObject({ runKey: 'a-1' });
      expect(task.subtasks).toEqual([
        { id: 's1', title: 'first', status: 'merged', depends: [], files: ['a.ts'] },
        { id: 's2', title: 'second', status: 'waiting', depends: ['s1'], files: ['b.ts'] },
      ]);
    }));

  it('reads the last 20 messages and counts the older ones', () =>
    withState(async (h, state) => {
      const id = await h.addBacklog();
      for (let number = 1; number <= 25; number += 1) await h.addMessage(id, `message ${number}`);

      const read = await state.read('alpha', 'turn-1');

      expect(read.messages).toHaveLength(20);
      expect(read.messages[0].text).toBe('message 6');
      expect(read.messages.at(-1)?.text).toBe('message 25');
      expect(read.olderMessages).toBe(5);
    }));

  it('reads the events of the turn with their facts, and no others', () =>
    withState(async (h, state) => {
      const id = await h.addBacklog();
      await h.addEvent(id, 'e1', 'run-chat', { slug: 'a', message: 'hi', reply: 'ok' });
      await h.chat.takeInto(id, 'turn-1');
      await h.addEvent(id, 'e2', 'main-green', { repository: 'web', head: 'h' });

      const read = await state.read('alpha', 'turn-1');

      expect(read.events).toMatchObject([{ kind: 'run-chat', facts: { message: 'hi', reply: 'ok' } }]);
    }));

  it('shows a change made by hand and an answer given on the run page at the next read', () =>
    withState(async (h, state) => {
      const id = await h.addBacklog();
      const active = await milestone(h, id, 1, 'active');
      const task = await h.addTask(id, 'a', { milestoneId: active, runKey: 'a-1' });
      await h.addRun('a-1');
      const move = async (change: RunStateChange) => {
        const run = (await h.runs.findRun('a-1')) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
        writeRunState(run, change);
        await storeRun(h.runs, run);
      };
      await move({ status: 'blocked', reason: { code: 'NEEDS_ANSWER', message: 'which library?' } });
      const waiting = (await state.read('alpha', 't1')).active?.tasks[0];

      await h.backlogs.saveTask({ ...task, description: 'Do a, by hand' });
      await move({ status: 'running' });

      const read = (await state.read('alpha', 't2')).active?.tasks[0];
      expect(read?.description).toBe('Do a, by hand');
      expect(read?.status).not.toBe(waiting?.status);
    }));

  it('fails with a plain reason for a backlog that is not there', () =>
    withState(async (_h, state) => {
      await expect(state.read('nope', 't1')).rejects.toThrow('no backlog nope');
    }));
});
