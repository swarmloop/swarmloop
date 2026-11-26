import { existsSync } from 'fs';
import { join } from 'path';
import { attachmentsDir } from '../../../history/run-paths';
import { repositoryVisit } from '../../../history/repository.spec-helpers';
import { VisitRepository } from '../../../history/visit.repository';
import { storeRun } from '../../../testing/store-run.spec-helpers';
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

  it('writes a merged and a skipped task as one line and keeps every line of the others', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      const lines = { files: ['done.ts'], covers: ['R1'] };
      await h.addTask(id, 'done', { ...lines, status: 'merged', runKey: 'done-1' });
      await h.addTask(id, 'dropped', { ...lines, status: 'skipped' });
      await h.addTask(id, 'later', { files: ['later.ts'], description: 'Later brief.' });

      const text = await prompt.build('alpha', 't1', mounts, ['web']);

      expect(text).toContain(
        '- done [merged] run done-1: done\n- dropped [skipped]: dropped\n- later [waiting]: later',
      );
      expect(text).not.toContain('files: done.ts');
      expect(text).toContain('files: later.ts');
      expect(text).toContain('Later brief.');
    }));

  it('writes the follow-up of a turn with a message as the brief writes it', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      await h.addMessage(id, 'plan search');
      await h.chat.takeInto(id, 't1');
      const brief = await prompt.build('alpha', 't1', mounts, ['web']);
      await h.addMessage(id, 'and also filters');
      const added = await h.chat.takeInto(id, 't1');

      const text = await prompt.followUp('alpha', 't1', { messages: [added.messages[1]], events: [] });

      const line = `person (${added.messages[1].createdAt}): and also filters`;
      expect(text).toContain('Give your whole answer again, with its result block, taking them in.');
      expect(text).toContain(line);
      expect(text).not.toContain('plan search');
      expect(brief).toContain(`person (${added.messages[0].createdAt}): plan search`);
      expect(text.split('\n').filter((item) => item.startsWith('person ('))).toEqual([line]);
    }));

  it('gives an event that comes mid-turn the facts and whole-text file it has in a brief', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      await h.addRun('run-1');
      const run = (await h.runs.findRun('run-1')) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
      run.currentStep = 'implement';
      await storeRun(h.runs, run);
      const long = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
      await h.app.get(VisitRepository).finishVisit(run, {
        ...repositoryVisit(),
        step: 'implement',
        document: { kind: 'error', fileName: 'error.md', body: long },
      });
      await h.addEvent(id, 'e1', 'run-needs-person', { runKey: 'run-1', state: 'failed', reason: '' });
      const added = await h.chat.takeInto(id, 't1');

      const followUp = await prompt.followUp('alpha', 't1', added);
      const brief = await prompt.build('alpha', 't1', mounts, ['web']);

      const note = /\d+ earlier lines are left out; the whole text is in \/work\/brief\/attachments\/run-1-\w+\.txt\./;
      expect(followUp).toContain('- run needs person at ');
      expect(followUp).toContain('line 100');
      expect(followUp).toMatch(note);
      expect(brief).toMatch(note);
      expect(followUp.match(note)?.[0]).toBe(brief.match(note)?.[0]);
      expect(existsSync(join(attachmentsDir(h.config, 't1'), 'run-1-error.txt'))).toBe(true);
    }));
});
