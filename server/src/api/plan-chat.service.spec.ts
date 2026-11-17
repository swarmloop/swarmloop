import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Clock } from '../core/clock';
import { AttachmentStore } from '../history/attachment-store';
import { CheckoutRepository } from '../history/checkout.repository';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { PlannerTurns } from '../pipeline/planner-turns';
import { SubtaskPort } from '../pipeline/subtask-port';
import { save } from '../testing/runs.spec-helpers';
import { CommandHandlers } from './command-handlers';
import { PlanChatService } from './plan-chat.service';
import { RunAnswersService } from './run-answers.service';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';
import { RunRebaseService } from './run-rebase.service';
import { RunSubtaskCommandsService } from './run-subtask-commands.service';
import { seededBoot } from './runs-boot.spec-helpers';

async function withPlanChat(
  test: (parts: {
    app: Awaited<ReturnType<typeof seededBoot>>;
    chat: PlanChatService;
    turns: PlannerTurns;
    started: jest.Mock;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-chat-'));
  const started = jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' });
  const app = await seededBoot(root, { startDetached: started });
  try {
    const turns = new PlannerTurns();
    const chat = new PlanChatService(
      app.get(RunRepository),
      app.get(RunQueriesService),
      app.get(CommandService),
      app.get(PlanChatStore),
      turns,
      app.get(AttachmentStore),
      app.get(Clock),
    );
    new CommandHandlers(
      app.get(CommandService),
      { reconcileCommands: jest.fn(), resumeSubtaskParents: jest.fn() } as never,
      app.get(RunCommandsService),
      app.get(RunAnswersService),
      app.get(RunSubtaskCommandsService),
      app.get(RunRebaseService),
      {} as never,
      {} as never,
      app.get(SubtaskPort),
      chat,
      app.get(AttachmentStore),
    ).onModuleInit();
    await test({ app, chat, turns, started });
  } finally {
    await app.close();
  }
}

describe('PlanChatService', () => {
  it('refuses an empty message and a run that is missing', async () => {
    await withPlanChat(async ({ chat }) => {
      await expect(chat.send('proj-1', '  ', 'ann')).rejects.toThrow(new BadRequestException('message is missing'));
      await expect(chat.send('proj-1', 'hello', 'ann')).rejects.toThrow(new NotFoundException('proj-1 is missing'));
    });
  });

  it('refuses a message to a subtask and names the parent', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const runs = app.get(RunRepository);
      const parent = await save(runs, 'proj-epic', 'implement', 'waiting');
      await runs.openSubtask('proj-epic-a', parent.id, 'a');
      await expect(chat.send('proj-epic-a', 'hello', 'ann')).rejects.toThrow(
        new ConflictException('proj-epic-a is a subtask: talk to the planner of proj-epic'),
      );
    });
  });

  it('refuses a merged, a closed and a removed run with the follow-up text', async () => {
    await withPlanChat(async ({ app, chat }) => {
      const runs = app.get(RunRepository);
      const outcomes = {
        merged: JSON.stringify({ merged: { demo: { sha: 'abc', by: null, at: 'x', url: null } } }),
        closed: JSON.stringify({ closed: { repo: 'demo', by: null, at: 'x' } }),
      };
      for (const [name, outcome] of Object.entries(outcomes)) {
        const run = await save(runs, `proj-${name}`, 'done', 'done');
        run.mergeOutcome = outcome;
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
