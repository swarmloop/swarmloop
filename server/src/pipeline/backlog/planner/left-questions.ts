import { Injectable } from '@nestjs/common';
import { Clock } from '../../../core/clock';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogRecord } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import { RunRepository } from '../../../history/run.repository';
import { QuestionHolds } from '../../../steps/shared/question-holds';
import { QuestionPassOn } from '../../question-pass-on';
import type { PlannerRunCommand } from './planner-run-port';

/** The planner's line above a question its turn left. */
const LEFT_LINE = "The planner's turn ended without answering this question, so it goes to you.";

/** True when the command answered, passed on or wrote about this question: one that names other questions does not. */
function handles(command: PlannerRunCommand, runKey: string, questionId: string): boolean {
  if (command.run !== runKey) return false;
  switch (command.type) {
    case 'planChat':
      return true;
    case 'passOn':
      return command.question === undefined || command.question === questionId;
    case 'answer':
      return command.answers.some((answer) => answer.id === undefined || answer.id === questionId);
    case 'replay':
    case 'resume':
    case 'skipTask':
    case 'stop':
      return false;
  }
}

/** What became of a command of the turn: the run took it, its refusal went to the next turn as an event, or it was refused again for the same reason. */
export interface CommandOutcome {
  command: PlannerRunCommand;
  outcome: 'taken' | 'refused' | 'refused-again';
}

/** A question of a run that a turn has. */
interface TurnQuestion {
  runKey: string;
  questionId: string;
}

/**
 * The one rule of a question that stays with the planner only while a turn has it. A turn has the questions of its
 * own and taken-over `run-asks-planner` events and of the `command-refused` events it reads. As it ends it passes on
 * each one that is still held and that no command the run took answered, wrote about or passed on, and that no refusal
 * carried on to the next turn.
 */
@Injectable()
export class LeftQuestions {
  constructor(
    private readonly chat: BacklogChatRepository,
    private readonly holds: QuestionHolds,
    private readonly passOn: QuestionPassOn,
    private readonly runs: RunRepository,
    private readonly backlogs: BacklogRepository,
    private readonly clock: Clock,
  ) {}

  /** The ids of the turn's questions that the command answers, writes about or passes on. */
  async about(turnKey: string, command: PlannerRunCommand): Promise<string[]> {
    const questions = await this.questionsOf(turnKey);
    return questions
      .filter(({ runKey, questionId }) => handles(command, runKey, questionId))
      .map((item) => item.questionId);
  }

  /** Passes on each question of the turn that is still held and that no taken or carried-on command handled, and says so in the chat once per question. */
  async pass(backlog: BacklogRecord, turnKey: string, outcomes: CommandOutcome[]): Promise<void> {
    const handled = outcomes.filter(({ outcome }) => outcome !== 'refused-again').map(({ command }) => command);
    for (const [index, { runKey, questionId }] of (await this.questionsOf(turnKey)).entries()) {
      if (handled.some((command) => handles(command, runKey, questionId))) continue;
      const run = await this.runs.findRun(runKey);
      if (!run || !(await this.holds.held(run)).some((item) => item.id === questionId)) continue;
      if ((await this.passOn.pass(run.key, questionId, LEFT_LINE)).length === 0) continue;
      await this.backlogs.addMessage({
        backlogId: backlog.id as number,
        messageKey: `${turnKey}-left-${index}`,
        author: 'planner',
        kind: 'info',
        text: `My turn ended without answering the question of ${run.key}, so it now goes to you.`,
        proposes: null,
        turn: turnKey,
        attachments: [],
        createdAt: this.clock.iso(),
      });
    }
  }

  /** The questions the turn has, in event order: those its events ask and those the refusals it reads name. */
  private async questionsOf(turnKey: string): Promise<TurnQuestion[]> {
    const { events } = await this.chat.itemsOfTurn(turnKey);
    const found = new Map<string, TurnQuestion>();
    for (const { kind, facts } of events) {
      let runKey = '';
      let ids: string[] = [];
      if (kind === 'run-asks-planner') {
        runKey = facts.runKey;
        ids = [facts.questionId];
      } else if (kind === 'command-refused' && facts.questions) {
        runKey = facts.run;
        ids = facts.questions.split('\n');
      }
      for (const questionId of ids) found.set(`${runKey}\n${questionId}`, { runKey, questionId });
    }
    return [...found.values()];
  }
}
