import { Injectable } from '@nestjs/common';
import { Clock } from '../../../core/clock';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogRecord } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import { RunRepository } from '../../../history/run.repository';
import { QuestionHolds } from '../../../steps/shared/question-holds';
import { QuestionPassOn } from '../../question-pass-on';
import { PlannerBacklogCalls } from './planner-backlog-calls';
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

/**
 * A turn that ran to its end passes on the questions of runs it was given and neither answered, wrote to the run's
 * planner about, nor passed on itself, so no question stays with a planner that has taken its turn.
 */
@Injectable()
export class LeftQuestions {
  constructor(
    private readonly chat: BacklogChatRepository,
    private readonly calls: PlannerBacklogCalls,
    private readonly holds: QuestionHolds,
    private readonly passOn: QuestionPassOn,
    private readonly runs: RunRepository,
    private readonly backlogs: BacklogRepository,
    private readonly clock: Clock,
  ) {}

  /** Passes on each question of the turn's events that is still held, and says so in the chat once per question. */
  async pass(backlog: BacklogRecord, turnKey: string): Promise<void> {
    const { events } = await this.chat.itemsOfTurn(turnKey);
    const asked = events.filter((event) => event.kind === 'run-asks-planner');
    if (asked.length === 0) return;
    const handled = (await this.calls.recorded(backlog.id as number, turnKey)).map(({ command }) => command);
    for (const [index, { facts }] of asked.entries()) {
      if (handled.some((command) => handles(command, facts.runKey, facts.questionId))) continue;
      const run = await this.runs.findRun(facts.runKey);
      if (!run || !(await this.holds.held(run)).some((item) => item.id === facts.questionId)) continue;
      if ((await this.passOn.pass(run.key, facts.questionId, LEFT_LINE)).length === 0) continue;
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
}
