import type { OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { TurnAnswer } from '../agent-result/definitions/backlog-turn';
import { CommandService } from '../pipeline/command.service';
import { PlannerRunPort, type PlannerRunCommand } from '../pipeline/backlog/planner/planner-run-port';
import { PERSON_RESUME } from '../pipeline/resume-sender';
import { QuestionPassOn } from '../pipeline/question-pass-on';
import { PlanChatService } from './plan-chat.service';

/**
 * Answers that each name a question go the way the person's route sends them. Any other answer goes as a message,
 * which answers every open question the way a plan-chat message does.
 */
function answerPayload(answers: TurnAnswer[]): { answers: TurnAnswer[] } | { message: string } {
  if (answers.length > 0 && answers.every((answer) => answer.kind && answer.id)) return { answers };
  return { message: answers.map((answer) => answer.body.trim()).join('\n\n') };
}

/** Sends the planner's commands to a run the way the person's routes do: the same commands, the owner as the person. */
@Injectable()
export class PlannerRunCommands implements OnModuleInit {
  constructor(
    private readonly port: PlannerRunPort,
    private readonly commands: CommandService,
    private readonly chat: PlanChatService,
    private readonly passOn: QuestionPassOn,
  ) {}

  onModuleInit(): void {
    this.port.register((command, owner, key) => this.send(command, owner, key));
  }

  private async send(command: PlannerRunCommand, owner: string, idempotencyKey: string): Promise<void> {
    const options = { idempotencyKey };
    switch (command.type) {
      case 'answer':
        await this.commands.submit('answer', command.run, answerPayload(command.answers), options);
        return;
      case 'resume':
        await this.commands.submit('resume', command.run, { ...PERSON_RESUME }, { ...options, actor: owner });
        return;
      case 'replay':
        await this.commands.submit(
          'replay',
          command.run,
          { step: command.step, prompt: command.instruction },
          { ...options, actor: owner },
        );
        return;
      case 'rebase':
        await this.commands.submit('rebase', command.run, {}, { ...options, actor: owner });
        return;
      case 'skipTask':
        await this.commands.submit('skip', command.run, { taskId: command.task }, options);
        return;
      case 'stop':
        await this.commands.submit('stop', command.run, {}, options);
        return;
      case 'planChat':
        await this.chat.sendToPlanner(command.run, command.message, owner, idempotencyKey);
        return;
      case 'passOn':
        await this.passOn.passOrRefuse(command.run, command.question, command.line);
        return;
    }
  }
}
