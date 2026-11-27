import { Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { AddProjectBody } from '../contract/api';
import { CommandService } from '../pipeline/command.service';
import { Reconciler } from '../pipeline/reconciler';
import { startByOf } from '../pipeline/resume-sender';
import { SubtaskPort } from '../pipeline/subtask-port';
import { RunAnswersService } from './run-answers.service';
import { RunCommandsService, StartPlan } from './run-commands.service';
import { RunSubtaskCommandsService } from './run-subtask-commands.service';
import { RunRebaseService } from './run-rebase.service';
import { AttachmentStore } from '../history/attachment-store';
import type { SubtaskStart } from '../steps/shared/subtask-ops';
import { PlanChatService } from './plan-chat.service';

export interface ReplayPayload {
  step: string;
  prompt: string;
  phases?: string[];
  /** Who asks: a planner with its level, or the person's mark. No `by` is the person's replay. */
  by?: string;
  level?: number;
  /** Ids of the uploaded files the run takes. */
  attachments?: string[];
}

/** A replay with no `by` stays the person's, so it passes no starter. */
function replayStarter(payload: ReplayPayload): SubtaskStart | undefined {
  if (payload.by === 'planner' && typeof payload.level === 'number') return { by: 'planner', level: payload.level };
  return payload.by === 'person' ? { by: 'person', level: null } : undefined;
}

/** Maps each command type to the service that did the work before the command path. */
@Injectable()
export class CommandHandlers implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly executor: CommandService,
    private readonly reconciler: Reconciler,
    private readonly runs: RunCommandsService,
    private readonly answering: RunAnswersService,
    private readonly taskCommands: RunSubtaskCommandsService,
    private readonly rebases: RunRebaseService,
    private readonly subtasks: SubtaskPort,
    private readonly planChat: PlanChatService,
    private readonly files: AttachmentStore,
  ) {}

  onModuleInit(): void {
    this.subtasks.register({
      open: (parent, task) => this.taskCommands.openSubtask(parent, task),
      launch: (parent, task) => this.taskCommands.launchSubtask(parent, task),
    });
    const on = this.executor.register.bind(this.executor);
    on('start', async (key, payload) => {
      await this.files.claim(key, payload.attachments as string[] | undefined);
      return this.runs.startPlanned(payload as unknown as StartPlan);
    });
    on('resume', (key, payload) =>
      this.runs.resume(key, payload.prompt as string | undefined, startByOf({ payload: JSON.stringify(payload) })),
    );
    on('answer', (key, payload) =>
      typeof payload.message === 'string'
        ? this.answering.fromMessage(key, payload.message)
        : this.answering.answers(key, payload),
    );
    on('plan-chat', (key, payload, context) => this.planChat.record(key, payload, context.commandId));
    on('replay', async (key, payload) => {
      const replay = payload as unknown as ReplayPayload;
      await this.files.claim(key, replay.attachments);
      return this.runs.replay(key, replay.step, replay.prompt, replay.phases, replayStarter(replay));
    });
    on('stop', (key) => this.runs.stop(key));
    on('remove', (key) => this.runs.remove(key));
    on('skip', (key, payload) => this.taskCommands.skipTask(key, (payload.taskId as string | undefined) ?? ''));
    on('projects', (key, payload) => this.runs.addProject(key, (payload as AddProjectBody).name ?? ''));
    on('rebase', (key, payload) =>
      typeof payload.main === 'string'
        ? this.rebases.rebase(key, false, payload.main)
        : this.rebases.rebase(
            key,
            payload.byParent === true,
            undefined,
            payload.keepsWait === true,
            typeof payload.hostConflict === 'string' ? payload.hostConflict : null,
          ),
    );
  }

  /** The commands a server that stopped left behind: the reconciler settles them. */
  async onApplicationBootstrap(): Promise<void> {
    await this.reconciler.reconcileCommands();
    await this.reconciler.resumeSubtaskParents();
  }
}
