import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { attachmentsDir, root } from '../../../history/run-paths';
import { sessionHome } from '../../../history/session-group';
import { agentStateDir } from '../../../sandbox/sandbox-launch';
import { plannerChatKey } from './planner-chat-key';
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
    const state = new BacklogTurnState(h.backlogs, h.chat, h.runs, h.documents, h.eventFacts(), h.runReasons());
    await body(h, new BacklogTurnPrompt(state, h.config));
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

      const text = (await prompt.build('alpha', 't1', mounts, ['web'])).fresh;

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

      const before = (await prompt.build('alpha', 't1', mounts, ['web'])).fresh;
      await h.addEvent(id, 'e1', 'run-needs-person', { slug: 'a', runKey: 'a-1' });
      await h.chat.takeInto(id, 't2');
      await h.documents.putDocument((await h.runs.findRun('a-1'))!, 'questions', 'Which library?');
      const after = (await prompt.build('alpha', 't2', mounts, ['web'])).fresh;

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

      const text = (await prompt.build('alpha', 't1', mounts, ['web'])).fresh;

      expect(text).toContain('Backlog items:\n- idea [waiting] revision 0: idea');
      expect(text).toContain('brief: 28 characters in /work/brief/tasks/idea.md');
      expect(text).not.toContain('Gives a thing.');
      expect(text).toContain('/work/web');
    }));

  it('writes a merged and a skipped task as one line and keeps every line of the others', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      const lines = { files: ['done.ts'], covers: ['R1'] };
      await h.addTask(id, 'done', { ...lines, status: 'merged', runKey: 'done-1' });
      await h.addTask(id, 'dropped', { ...lines, status: 'skipped' });
      await h.addTask(id, 'later', { files: ['later.ts'], description: 'Later brief.' });

      const text = (await prompt.build('alpha', 't1', mounts, ['web'])).fresh;

      expect(text).toContain(
        '- done [merged] revision 0 run done-1: done\n- dropped [skipped] revision 0: dropped\n- later [waiting] revision 0: later',
      );
      expect(text).not.toContain('files: done.ts');
      expect(text).toContain('files: later.ts');
      expect(text).toContain('brief: 12 characters in /work/brief/tasks/later.md');
    }));

  it('shows the reason of a failed run in the brief, and in the changes of a chat that saw the task before it failed', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'a', { runKey: 'a-1' });
      await h.addRun('a-1');
      const first = await prompt.build('alpha', 't1', mounts, ['web']);
      await h.chat.saveTurn({
        backlogId: id,
        turnKey: 't1',
        status: 'done',
        reason: '',
        nextTryAt: null,
        createdAt: h.clock.iso(),
        seenState: first.seen,
      });
      await h.endRun('a-1', 'failed', 'pipeline', 'the code host refuses to read pipelines (HTTP 403)');
      const reason = '    reason: pipeline step: the code host refuses to read pipelines (HTTP 403)';

      const { prompt: changes, fresh } = await prompt.build('alpha', 't2', mounts, ['web']);

      expect(first.fresh).not.toContain('    reason: ');
      expect(fresh).toContain('- a [blocked] revision 0 run a-1: a');
      expect(fresh).toContain(reason);
      expect(changes).toContain('Changed tasks, milestones and requirements:\n- a [blocked]');
      expect(changes).toContain(reason);
    }));

  it('writes the follow-up of a turn with a message as the brief writes it', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      await h.addMessage(id, 'plan search');
      await h.chat.takeInto(id, 't1');
      const brief = (await prompt.build('alpha', 't1', mounts, ['web'])).fresh;
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
      const brief = (await prompt.build('alpha', 't1', mounts, ['web'])).fresh;

      const note = /\d+ earlier lines are left out; the whole text is in \/work\/brief\/attachments\/run-1-\w+\.txt\./;
      expect(followUp).toContain('- run needs person at ');
      expect(followUp).toContain('line 100');
      expect(followUp).toMatch(note);
      expect(brief).toMatch(note);
      expect(followUp.match(note)?.[0]).toBe(brief.match(note)?.[0]);
      expect(existsSync(join(attachmentsDir(h.config, 't1'), 'run-1-error.txt'))).toBe(true);
    }));

  it('shows the newest 20 decisions with the count of older ones and where all are', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      for (let number = 1; number <= 23; number += 1) {
        await h.backlogs.addDecision({
          backlogId: id,
          text: `decided ${number}x`,
          who: 'owner',
          createdAt: h.clock.iso(),
        });
      }

      const { fresh } = await prompt.build('alpha', 't1', mounts, ['web']);

      expect(fresh).toContain('decided 4x');
      expect(fresh).toContain('decided 23x');
      expect(fresh).not.toContain('decided 3x');
      expect(fresh).toContain(
        '3 older decisions are left out; all of them, newest first, are in /work/brief/decisions.md.',
      );
    }));

  it('gives a chat that saw the state only what changed, and the messages and events of the turn', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'keep', { description: 'Keep brief.' });
      await h.addTask(id, 'edit', { description: 'Edit brief.' });
      await h.addTask(id, 'drop', { description: 'Drop brief.' });
      await h.backlogs.addDecision({ backlogId: id, text: 'old decision', who: 'owner', createdAt: h.clock.iso() });
      await h.addMessage(id, 'earlier talk');
      await h.chat.takeInto(id, 't1');
      const first = await prompt.build('alpha', 't1', mounts, ['web']);
      await h.chat.saveTurn({
        backlogId: id,
        turnKey: 't1',
        status: 'done',
        reason: '',
        nextTryAt: null,
        createdAt: h.clock.iso(),
        seenState: first.seen,
      });
      const tasks = await h.backlogs.tasks(id);
      await h.backlogs.saveTask({ ...tasks.find((task) => task.slug === 'edit')!, description: 'Edited by a person.' });
      await h.backlogs.saveTask({ ...tasks.find((task) => task.slug === 'keep')!, note: 'waits for main' });
      await h.backlogs.deleteTask(tasks.find((task) => task.slug === 'drop')!.id as number);
      await h.backlogs.addDecision({ backlogId: id, text: 'new decision', who: 'owner', createdAt: h.clock.iso() });
      await h.addMessage(id, 'a short yes');
      await h.chat.takeInto(id, 't2');

      const { prompt: text, fresh } = await prompt.build('alpha', 't2', mounts, ['web']);

      expect(
        text.startsWith(
          'Plan the backlog alpha: answer the messages and the events of this turn. What changed since your last turn:',
        ),
      ).toBe(true);
      expect(text).toContain('Changed tasks, milestones and requirements:\n- keep [');
      expect(text).toContain('- edit [waiting] revision 0: edit');
      expect(text).toContain('waits: waits for main');
      expect(text).toContain('no longer in the backlog: task:drop');
      expect(text).toContain('its brief changed: /work/brief/tasks/edit.md');
      expect(text).toContain('- new decision (owner)');
      expect(text).not.toContain('old decision');
      expect(text).toContain('a short yes');
      expect(text).not.toContain('earlier talk');
      expect(text).not.toContain('Backlog items');
      expect(fresh).toContain('Backlog items');
    }));

  it('gives prompt equal to fresh with no seen state or an unreadable one', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      const none = await prompt.build('alpha', 't1', mounts, ['web']);
      await h.chat.saveTurn({
        backlogId: id,
        turnKey: 't1',
        status: 'done',
        reason: '',
        nextTryAt: null,
        createdAt: h.clock.iso(),
        seenState: '{not json',
      });
      const unreadable = await prompt.build('alpha', 't2', mounts, ['web']);

      expect(none.prompt).toBe(none.fresh);
      expect(unreadable.prompt).toBe(unreadable.fresh);
    }));

  it('writes the brief files of the planner chat before it returns', () =>
    withPrompt(async (h, prompt) => {
      const id = await h.addBacklog();
      await h.addTask(id, 'idea', { description: 'Gives a thing.' });

      await prompt.build('alpha', 't1', mounts, ['web']);

      const dir = join(agentStateDir(root(h.config), plannerChatKey(id), sessionHome('backlog-plan')), 'briefs');
      expect(readFileSync(join(dir, 'tasks', 'idea.md'), 'utf8')).toBe('Gives a thing.');
    }));
});
