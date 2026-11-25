import { BacklogTurnPrompt } from './turn-prompt';
import { plannerFacts } from './planner-facts.spec-helpers';
import { BacklogTurnState } from './turn-state';

type Harness = Awaited<ReturnType<typeof plannerFacts>>;

async function withPrompt(body: (h: Harness, prompt: BacklogTurnPrompt) => Promise<void>): Promise<void> {
  const h = await plannerFacts();
  try {
    const state = new BacklogTurnState(h.backlogs, h.chat, h.runs, h.documents, h.eventFacts());
    await body(h, new BacklogTurnPrompt(state));
  } finally {
    await h.close();
  }
}

const mounts = [{ hostPath: '/tmp/turn/web', containerPath: '/work/web', readonly: true }];

describe('BacklogTurnPrompt', () => {
  it('carries the last 20 messages and no older chat, and says how many are left out and where the whole is', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      for (let number = 1; number <= 25; number += 1) await h.addMessage(id, `chat line ${number}x`);

      const text = await prompt.build('alpha', 't1', mounts, ['web']);

      expect(text).toContain('chat line 6x');
      expect(text).toContain('chat line 25x');
      expect(text).not.toContain('chat line 5x');
      expect(text).toContain(
        '5 older messages are left out. The latest messages of the chat, and how many are older, are at GET /backlogs/alpha/messages.',
      );
    }));

  it('shows an answer given on the run page at the next build, from the run state and not from a chat', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      const active = (
        await h.backlogs.saveMilestone({
          backlogId: id,
          number: 1,
          title: 'First',
          goal: 'ship it',
          status: 'active',
          createdAt: h.clock.iso(),
        })
      ).id as number;
      await h.addTask(id, 'a', { milestoneId: active, runKey: 'a-1' });
      await h.addRun('a-1', {
        subtasks: JSON.stringify([
          { id: 's1', title: 'part one', description: '', depends: [], files: ['x.ts'], proof: '' },
        ]),
      });
      await h.chats.appendEntry('a-1', {
        key: 'k',
        role: 'person',
        text: 'secret run chat text',
        at: h.clock.iso(),
        state: 'taken',
      });

      const before = await prompt.build('alpha', 't1', mounts, ['web']);
      await h.addEvent(id, 'e1', 'run-needs-person', { slug: 'a', runKey: 'a-1' });
      await h.chat.takeInto(id, 't2');
      await h.documents.putDocument((await h.runs.findRun('a-1'))!, 'questions', 'Which library?');
      const after = await prompt.build('alpha', 't2', mounts, ['web']);

      expect(before).toContain('- a [');
      expect(before).toContain('run a-1');
      expect(before).toContain('subtask s1 [waiting]: part one; depends: none; files: x.ts');
      expect(before).not.toContain('secret run chat text');
      expect(after).toContain('run needs person');
      expect(after).toContain('question: Which library?');
      expect(after).not.toContain('secret run chat text');
    }));

  it('shows a task that has not started with its brief, and the mounted repositories', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'idea', { description: 'Gives a thing.\n\nRules\n- none' });

      const text = await prompt.build('alpha', 't1', mounts, ['web']);

      expect(text).toContain('Backlog items:\n- idea [waiting]: idea');
      expect(text).toContain('Gives a thing.');
      expect(text).toContain('/work/web');
    }));
});
