import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Clock } from '../core/clock';
import { AttachmentStore } from '../history/attachment-store';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { RedMainWait } from '../pipeline/backlog/red-main-wait';
import { BacklogRepository } from '../history/backlog.repository';
import { CheckoutRepository } from '../history/checkout.repository';
import { DocumentRepository } from '../history/document.repository';
import { PipelineService } from '../pipeline/pipeline.service';
import type { RepositoryHost } from '../steps/shared/repository-host';
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
  /** What the host reads of every repository's main; red until a spec sets it. */
  main: { state: 'red' | 'green' };
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
    const main = { state: 'red' as 'red' | 'green' };
    const host = { main: async () => ({ state: main.state }) } as unknown as RepositoryHost;
    const redMain = new RedMainWait(app.get(BacklogRepository), app.get(RunRepository), host);
    const answering = new RunAnswersService(
      app.get(RunRepository),
      app.get(DocumentRepository),
      app.get(CheckoutRepository),
      app.get(PipelineService),
      app.get(RunQueriesService),
      app.get(RunCommandsService),
      app.get(Clock),
      undefined,
      redMain,
    );
    new CommandHandlers(
      app.get(CommandService),
      { reconcileCommands: jest.fn(), resumeSubtaskParents: jest.fn() } as never,
      app.get(RunCommandsService),
      answering,
      app.get(RunSubtaskCommandsService),
      app.get(RunRebaseService),
      app.get(SubtaskPort),
      chat,
      app.get(AttachmentStore),
      {} as never,
    ).onModuleInit();
    const port = new PlannerRunPort();
    new PlannerRunCommands(
      port,
      app.get(CommandService),
      chat,
      app.get(QuestionPassOn),
      redMain,
      app.get(RunRepository),
    ).onModuleInit();
    await test({ app, chat, turns, started, port, main });
  } finally {
    await app.close();
  }
}
