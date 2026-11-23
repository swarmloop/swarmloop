import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Clock } from '../core/clock';
import { AttachmentStore } from '../history/attachment-store';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { QuestionPassOn } from '../pipeline/question-pass-on';
import { PlannerRunPort } from '../pipeline/backlog/planner/planner-run-port';
import { PlannerTurns } from '../pipeline/planner-turns';
import { SubtaskPort } from '../pipeline/subtask-port';
import { CommandHandlers } from './command-handlers';
import { PlanChatService } from './plan-chat.service';
import { PlannerRunCommands } from './planner-run-commands';
import { RunAnswersService } from './run-answers.service';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';
import { RunRebaseService } from './run-rebase.service';
import { RunSubtaskCommandsService } from './run-subtask-commands.service';
import { seededBoot } from './runs-boot.spec-helpers';

/** What a spec of the answer routes gets: the app, the plan chat, and the planner's way into a run. */
interface AnswerRoutes {
  app: Awaited<ReturnType<typeof seededBoot>>;
  chat: PlanChatService;
  turns: PlannerTurns;
  started: jest.Mock;
  port: PlannerRunPort;
}

/** Boots the app with the command handlers and the planner's run commands wired to the real routes. */
export async function withAnswerRoutes(test: (parts: AnswerRoutes) => Promise<void>): Promise<void> {
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
    const port = new PlannerRunPort();
    new PlannerRunCommands(port, app.get(CommandService), chat, app.get(QuestionPassOn)).onModuleInit();
    await test({ app, chat, turns, started, port });
  } finally {
    await app.close();
  }
}
