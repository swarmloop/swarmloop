import { Injectable, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { AddProjectBody, StartStepBody } from '../contract/api';
import { CommandService } from '../pipeline/command.service';
import { ChatService } from './chat.service';
import { RunCommandsService, StartPlan } from './run-commands.service';
import { RunRebaseService } from './run-rebase.service';
import { ShellService } from './shell.service';

/** What the shell command carries: one of the three shell actions. */
export type ShellPayload = { op: 'open'; path: string } | { op: 'lock'; container: string } | { op: 'unlock' };

/** What the step and replay commands carry next to the step name. */
export interface StepPayload {
  step: string;
  body: StartStepBody;
}
export interface ReplayPayload {
  step: string;
  prompt: string;
  phases?: string[];
}

/** Maps each command type to the service that did the work before the command path. */
@Injectable()
export class CommandHandlers implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly executor: CommandService,
    private readonly runs: RunCommandsService,
    private readonly rebases: RunRebaseService,
    private readonly chat: ChatService,
    private readonly shell: ShellService,
  ) {}

  onModuleInit(): void {
    const on = this.executor.register.bind(this.executor);
    on('start', (_key, payload) => this.runs.startPlanned(payload as unknown as StartPlan));
    on('resume', (key, payload) => this.runs.resume(key, payload.prompt as string | undefined));
    on('answer', (key, payload) => this.runs.answers(key, payload));
    on('step', (key, payload) => {
      const { step, body } = payload as unknown as StepPayload;
      return this.runs.startStep(key, step, body);
    });
    on('replay', (key, payload) => {
      const { step, prompt, phases } = payload as unknown as ReplayPayload;
      return this.runs.replay(key, step, prompt, phases);
    });
    on('stop', (key) => this.runs.stop(key));
    on('remove', (key) => this.runs.remove(key));
    on('projects', (key, payload) => this.runs.addProject(key, (payload as AddProjectBody).name ?? ''));
    on('rebase', (key) => this.rebases.rebase(key));
    on('chat', (key, payload) => this.chat.speak(key, payload));
    on('rewind', (key, payload) => this.shell.rewind(key, Number(payload.id)));
    on('shell', (key, payload, context) => {
      const action = payload as unknown as ShellPayload;
      if (action.op === 'open') return this.shell.open(action.path, context.created);
      return action.op === 'lock' ? this.shell.lock(key, action.container) : this.shell.unlock(key);
    });
  }

  /** The accepted commands of a server that stopped run now. */
  onApplicationBootstrap(): Promise<void> {
    return this.executor.recover();
  }
}
