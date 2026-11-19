import type { OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { CommandService } from '../pipeline/command.service';
import { PlannerRunPort, type PlannerRunCommand } from '../pipeline/backlog/planner/planner-run-port';
import { PERSON_RESUME } from '../pipeline/resume-sender';
import { PlanChatService } from './plan-chat.service';

/** Sends the planner's commands to a run the way the person's routes do: the same commands, the owner as the person. */
@Injectable()
export class PlannerRunCommands implements OnModuleInit {
  constructor(
    private readonly port: PlannerRunPort,
    private readonly commands: CommandService,
    private readonly chat: PlanChatService,
  ) {}

  onModuleInit(): void {
    this.port.register((command, owner, key) => this.send(command, owner, key));
  }

  private async send(command: PlannerRunCommand, owner: string, idempotencyKey: string): Promise<void> {
    const options = { idempotencyKey };
    switch (command.type) {
      case 'answer':
        await this.commands.submit('answer', command.run, { answers: command.answers }, options);
        return;
      case 'resume':
        await this.commands.submit('resume', command.run, { ...PERSON_RESUME }, { ...options, actor: owner });
        return;
      case 'replay':
        await this.commands.submit(
          'replay',
          command.run,
          { step: command.step, prompt: '' },
          { ...options, actor: owner },
        );
        return;
      case 'skipTask':
        await this.commands.submit('skip', command.run, { taskId: command.task }, options);
        return;
      case 'stop':
        await this.commands.submit('stop', command.run, {}, options);
        return;
      case 'planChat':
        await this.chat.send(command.run, command.message, owner, idempotencyKey);
        return;
    }
  }
}
