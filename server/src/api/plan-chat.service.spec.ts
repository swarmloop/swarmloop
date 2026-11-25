import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Clock } from '../core/clock';
import { AttachmentStore } from '../history/attachment-store';
import { CheckoutRepository } from '../history/checkout.repository';
import { CommandRepository } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import type { MergeOutcome } from '../contract/run-state';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import type { PlannerTurns } from '../pipeline/planner-turns';
import { save } from '../testing/runs.spec-helpers';
import { PlanChatService } from './plan-chat.service';
import { RunQueriesService } from './run-queries.service';
import { withAnswerRoutes } from './answer-routes.spec-helpers';
import type { seededBoot } from './runs-boot.spec-helpers';

const withPlanChat = withAnswerRoutes;

describe('PlanChatService', () => {
  it('refuses an empty message and a run that is missing', async () => {
    await withPlanChat(async ({ chat }) => {
      await expect(chat.send('proj-1', '  ', 'ann')).rejects.toThrow(new BadRequestException('message is missing'));
      await expect(chat.send('proj-1', 'hello', 'ann')).rejects.toThrow(new NotFoundException('proj-1 is missing'));
    });
  });

  it('takes a message to a running subtask as a pending message of its own chat', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const runs = app.get(RunRepository);
      const parent = await save(runs, 'proj-epic', 'implement', 'waiting');
      const subtask = await runs.openSubtask('proj-epic-a', parent.id, 'a');
      writeRunState(subtask, { status: 'running', currentStep: 'implement' });
      await runs.saveRun(subtask);
      const sent = await chat.send('proj-epic-a', 'use a cursor', 'ann');
      const log = await app.get(PlanChatStore).read('proj-epic-a');
      expect(log.entries).toEqual([
        expect.objectContaining({ key: `message-${sent.commandId}`, text: 'use a cursor', state: 'pending' }),
      ]);
    });
  });

  it("sends a merged subtask's message to the parent's chat, naming the task", async () => {
    await withPlanChat(async ({ app, chat }) => {
      const runs = app.get(RunRepository);
      const parent = await save(runs, 'proj-epic', 'implement', 'waiting');
      const subtask = await runs.openSubtask('proj-epic-a', parent.id, 'a');
      writeRunState(subtask, {
        status: 'done',
        currentStep: 'done',
        merge: { merged: { demo: { sha: 'abc', by: null, at: 'x', url: null } } },
      });
      await runs.saveRun(subtask);
      await chat.send('proj-epic-a', 'rename it', 'ann');
      const log = await app.get(PlanChatStore).read('proj-epic');
      expect(log.entries).toEqual([expect.objectContaining({ text: 'About a: rename it', state: 'pending' })]);
      expect((await app.get(PlanChatStore).read('proj-epic-a')).entries).toEqual([]);
    });
  });

  it('refuses a merged, a closed and a removed run with the follow-up text', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const runs = app.get(RunRepository);
      const outcomes: Record<string, MergeOutcome> = {
        merged: { merged: { demo: { sha: 'abc', by: null, at: 'x', url: null } } },
        closed: { closed: { repo: 'demo', by: null, at: 'x' } },
      };
      for (const [name, outcome] of Object.entries(outcomes)) {
        const run = await save(runs, `proj-${name}`, 'done', 'done');
        writeRunState(run, { status: 'done', currentStep: 'done', merge: outcome });
        await runs.saveRun(run);
        await expect(chat.send(`proj-${name}`, 'more', 'ann')).rejects.toThrow(
          new ConflictException(`proj-${name} is ${name}: start a follow-up run`),
        );
      }
      const removed = await save(runs, 'proj-removed', 'done', 'done');
      removed.workspace = 'removed';
      await runs.saveRun(removed);
      await expect(chat.send('proj-removed', 'more', 'ann')).rejects.toThrow(
        new ConflictException('proj-removed is removed: start a follow-up run'),
      );
    });
  });

  it('takes a message as the answer to every open question and lets the run go on', async () => {
    await withPlanChat(async ({ app, chat, started }) => {
      const run = await save(app.get(RunRepository), 'proj-3', 'research', 'waiting');
      await app.get(DocumentRepository).putDocument(run, 'questions', '- which limit\n- which store\n');
      const sent = await chat.send('proj-3', ' use three, in memory ', 'ann');
      const answers = await app.get(DocumentRepository).latestBody('proj-3', 'answers');
      expect(answers).toContain('question: which limit\nanswer: use three, in memory');
      expect(answers).toContain('question: which store\nanswer: use three, in memory');
      expect(started).toHaveBeenCalledWith('proj-3');
      expect(sent.commandId).toBeTruthy();
      const log = await app.get(PlanChatStore).read('proj-3');
      expect(log.entries).toEqual([
        expect.objectContaining({ key: `message-${sent.commandId}`, text: 'use three, in memory', state: 'taken' }),
      ]);
    });
  });

  it('stores a message sent right after an answer as pending for the planner, not refused', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const run = await save(app.get(RunRepository), 'proj-3', 'research', 'waiting');
      await app.get(DocumentRepository).putDocument(run, 'questions', '- which limit\n');
      await chat.send('proj-3', 'three', 'ann');
      const later = await chat.send('proj-3', 'and log it', 'ann');
      const stored = await app.get(CommandRepository).find(later.commandId);
      expect(stored?.type).toBe('plan-chat');
      const log = await app.get(PlanChatStore).read('proj-3');
      expect(log.entries).toContainEqual(
        expect.objectContaining({ key: `message-${later.commandId}`, text: 'and log it', state: 'pending' }),
      );
    });
  });

  it('sends a message to the planner as plan-chat while a question waits, with the checks of send', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const run = await save(app.get(RunRepository), 'proj-3', 'research', 'waiting');
      await app.get(DocumentRepository).putDocument(run, 'questions', '- which limit\n');
      const sent = await chat.sendToPlanner('proj-3', ' add a task ', 'ann');
      expect((await app.get(CommandRepository).find(sent.commandId))?.type).toBe('plan-chat');
      expect(await app.get(DocumentRepository).latestBody('proj-3', 'answers')).toBeFalsy();
      await expect(chat.sendToPlanner('proj-3', ' ', 'ann')).rejects.toThrow(
        new BadRequestException('message is missing'),
      );
      await expect(chat.sendToPlanner('nope-1', 'hi', 'ann')).rejects.toThrow(NotFoundException);
    });
  });

  it('stores the author of a message that answers the questions on the answer command', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const run = await save(app.get(RunRepository), 'proj-3', 'research', 'waiting');
      await app.get(DocumentRepository).putDocument(run, 'questions', '- which limit\n');
      const sent = await chat.send('proj-3', 'three', 'ann');
      const stored = await app.get(CommandRepository).find(sent.commandId);
      expect(stored?.type).toBe('answer');
      expect(stored?.actor).toBe('ann');
    });
  });

  it('gives a message to the oldest open paste item', async () => {
    await withPlanChat(async ({ app, chat, started }) => {
      const run = await save(app.get(RunRepository), 'proj-4', 'requirements', 'waiting');
      await app
        .get(DocumentRepository)
        .putDocument(run, 'pending', JSON.stringify({ url: 'https://wiki.example/page' }));
      await chat.send('proj-4', 'the page text', 'ann');
      const pastes = await app.get(CheckoutRepository).listPastes('proj-4');
      expect(pastes.map(({ url, body }) => [url, body])).toEqual([['https://wiki.example/page', 'the page text']]);
      expect(started).toHaveBeenCalled();
    });
  });

  it('stores a message pending while the run is held, and offers it to the planner turns', async () => {
    await withPlanChat(async ({ app, chat, turns, started }) => {
      const runs = app.get(RunRepository);
      const run = await save(runs, 'proj-5', 'implement', 'running');
      writeRunState(run, { status: 'running', currentStep: 'implement', ownerPid: process.pid });
      await runs.saveRun(run);
      const sent = await chat.send('proj-5', 'also add a flag', 'ann');
      const log = await app.get(PlanChatStore).read('proj-5');
      expect(log.entries).toEqual([
        expect.objectContaining({
          key: `message-${sent.commandId}`,
          author: 'ann',
          text: 'also add a flag',
          state: 'pending',
        }),
      ]);
      expect(turns.pending('proj-5').map((turn) => turn.text)).toEqual(['also add a flag']);
      expect(started).not.toHaveBeenCalled();
      expect(sent.conversation?.composer).toBe('amend');
      expect(sent.conversation?.entries).toHaveLength(1);
    });
  });

  describe('for a split run', () => {
    const splitChat = (app: Awaited<ReturnType<typeof seededBoot>>, turns: PlannerTurns, amendDone: jest.Mock) =>
      new PlanChatService(
        app.get(RunRepository),
        app.get(RunQueriesService),
        app.get(CommandService),
        app.get(PlanChatStore),
        turns,
        app.get(AttachmentStore),
        app.get(Clock),
        { amendDone } as never,
      );

    it('starts the background turn for a done run, so it can reopen on added tasks', async () => {
      await withPlanChat(async ({ app, turns }) => {
        const runs = app.get(RunRepository);
        const run = await save(runs, 'proj-7', 'done', 'done');
        run.split = true;
        writeRunState(run, { status: 'done', currentStep: 'done' });
        await runs.saveRun(run);
        const amendDone = jest.fn();
        await splitChat(app, turns, amendDone).record('proj-7', { message: 'add d' }, 'cmd-1');
        expect(amendDone).toHaveBeenCalledWith('proj-7');
      });
    });

    it('leaves the message pending for the driver while the run waits in implement', async () => {
      await withPlanChat(async ({ app, turns }) => {
        const runs = app.get(RunRepository);
        const run = await save(runs, 'proj-8', 'implement', 'waiting');
        run.split = true;
        await runs.saveRun(run);
        const amendDone = jest.fn();
        await splitChat(app, turns, amendDone).record('proj-8', { message: 'add d' }, 'cmd-1');
        expect(amendDone).not.toHaveBeenCalled();
        expect(turns.pending('proj-8').map((turn) => turn.text)).toEqual(['add d']);
      });
    });
  });

  it('does what Resume does for a message to a run that failed or is blocked in planning', async () => {
    await withPlanChat(async ({ app, turns }) => {
      const runs = app.get(RunRepository);
      for (const [key, status] of [
        ['proj-11', 'failed'],
        ['proj-12', 'blocked'],
      ]) {
        await save(runs, key, 'plan', status);
      }
      const resume = jest.fn();
      const chat = new PlanChatService(
        runs,
        app.get(RunQueriesService),
        app.get(CommandService),
        app.get(PlanChatStore),
        turns,
        app.get(AttachmentStore),
        app.get(Clock),
        undefined,
        { resume } as never,
      );

      for (const key of ['proj-11', 'proj-12']) await chat.record(key, { message: 'split it differently' }, 'cmd-1');

      expect(resume.mock.calls.map(([key]) => key)).toEqual(['proj-11', 'proj-12']);
      expect(turns.pending('proj-11').map((turn) => turn.text)).toEqual(['split it differently']);
    });
  });

  it('leaves the author out when the request has no login and writes a replayed message once', async () => {
    await withPlanChat(async ({ app, chat }) => {
      await save(app.get(RunRepository), 'proj-6', 'plan', 'waiting');
      await chat.send('proj-6', 'first', null, 'same-key');
      await chat.send('proj-6', 'first', null, 'same-key');
      const { entries } = await app.get(PlanChatStore).read('proj-6');
      expect(entries).toHaveLength(1);
      expect(entries[0]).not.toHaveProperty('author');
    });
  });

  it('records the files sent with a message on its entry, on the plan-chat path and on the answer path', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const files = app.get(AttachmentStore);
      const runs = app.get(RunRepository);
      await save(runs, 'proj-7', 'plan', 'waiting');
      const one = await files.stage('shot.png', Buffer.from('png'));
      const sent = await chat.send('proj-7', 'see the shot', 'ann', undefined, [one.id]);
      const run = await save(runs, 'proj-8', 'research', 'waiting');
      await app.get(DocumentRepository).putDocument(run, 'questions', '- which limit\n');
      const two = await files.stage('limits.txt', Buffer.from('3'));
      const answered = await chat.send('proj-8', 'three', 'ann', undefined, [two.id]);
      const store = app.get(PlanChatStore);
      expect((await store.read('proj-7')).entries[0]).toEqual(
        expect.objectContaining({ key: `message-${sent.commandId}`, attachments: [one] }),
      );
      expect((await store.read('proj-8')).entries[0]).toEqual(
        expect.objectContaining({ key: `message-${answered.commandId}`, attachments: [two] }),
      );
      expect(files.names('proj-7')).toEqual(['shot.png']);
    });
  });

  it('keeps the staged files of a message it refuses, and records no files for a message without any', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const files = app.get(AttachmentStore);
      const staged = await files.stage('a.txt', Buffer.from('a'));
      await expect(chat.send('proj-9', 'hello', 'ann', undefined, [staged.id])).rejects.toThrow(NotFoundException);
      expect(files.names('proj-9')).toEqual([]);
      await save(app.get(RunRepository), 'proj-9', 'plan', 'waiting');
      await chat.send('proj-9', 'hello', 'ann', undefined, [staged.id]);
      await save(app.get(RunRepository), 'proj-10', 'plan', 'waiting');
      await chat.send('proj-10', 'plain', 'ann');
      expect(files.names('proj-9')).toEqual(['a.txt']);
      expect((await app.get(PlanChatStore).read('proj-10')).entries[0]).not.toHaveProperty('attachments');
    });
  });
});
