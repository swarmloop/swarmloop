import { Logger } from '@nestjs/common';
import type { Clock } from '../core/clock';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import type { Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import { openQuestions, unanswered } from '../steps/shared/answers';
import { renderQuestions } from '../steps/research/research-record';
import { SUBTASK_ASKING_STEPS } from '../steps/implement/implement-question';
import { storedAsks } from './stored-research';
import { subtaskAsks } from '../steps/plan/plan.prompts';
import { subtaskAnswer, type SubtaskAnswerResult } from '../agent-result/definitions/subtask-answer';
import type { OpenedStep } from '../steps/step-run';
import type { CommandService } from './command.service';

const ASKING_STEPS: string[] = ['research', 'code-review', ...SUBTASK_ASKING_STEPS];

/**
 * The parent planner's answer to the questions of a subtask: those of its research and code review, which the person's
 * Answer command closes, and the question of its implement or implement-improve, which waits in the subtask's own chat.
 */
export class SubtaskPlannerAnswer {
  private readonly logger = new Logger(SubtaskPlannerAnswer.name);
  /** The planner's reply per subtask run whose delivery was refused, so a retry sends it again and does not ask again. */
  private readonly undelivered = new Map<string, string>();

  constructor(
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly conversation: PlanConversation,
    private readonly visits: VisitRepository,
  ) {
    this.chat = conversation.chat;
    this.clock = conversation.clock;
  }

  private readonly chat: PlanChatStore;
  private readonly clock: Clock;

  async asking(run: RunEntity): Promise<boolean> {
    if (run.status !== 'waiting' || !ASKING_STEPS.includes(run.currentStep)) return false;
    if (SUBTASK_ASKING_STEPS.includes(run.currentStep)) return (await this.chatQuestionOf(run)) !== null;
    const questions = await this.askedBody(run);
    const answers = (await this.documents.latestBody(run.key, ARTIFACTS.answers.kind)) ?? '';
    return unanswered(questions, await storedAsks(this.documents, run.key), answers).length > 0;
  }

  /** True when the planner answered this run and its delivery was refused, so the next pass sends it again. */
  replyPending(child: RunEntity): boolean {
    return this.undelivered.has(child.key);
  }

  /** Asks the planner and sends the child its answer. Null, with nothing sent, when the planner gave none. */
  async answer(opened: OpenedStep, child: RunEntity, task: Subtask, contract: string): Promise<string | null> {
    const questions = await this.askedBody(child);
    const answer = this.undelivered.get(child.key) ?? (await this.askAbout(opened, task, questions, contract));
    if (answer === null) {
      // The person who started the run is asked next, from the questions the subtask holds.
      if (SUBTASK_ASKING_STEPS.includes(child.currentStep)) {
        await this.documents.putDocument(child, ARTIFACTS.questions.kind, questions);
      }
      return null;
    }
    try {
      await this.give(child, answer, `subtask-answer-${child.key}-${child.revision}`);
    } catch (error) {
      this.undelivered.set(child.key, answer);
      this.logger.warn(`${child.key} was not answered: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.undelivered.delete(child.key);
    return answer;
  }

  /** Sends the child the answer of the person to its open questions. The key names this ask of the child. */
  async deliver(child: RunEntity, text: string): Promise<void> {
    const key = `subtask-person-answer-${child.key}-${(await this.visits.listStats(child.id)).length}`;
    try {
      await this.give(child, text, key);
    } catch (error) {
      this.logger.warn(`${child.key} was not answered: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** The question of a subtask's implement that waits in its chat, or its answer that waits to be read; null for neither. */
  private async chatQuestionOf(run: RunEntity): Promise<PlanChatEntry | null> {
    const [question] = await this.chat.pendingQuestions(run.key);
    return question ?? (await this.chat.answerFor(run.key, run.currentStep));
  }

  /** Delivers the answer to a subtask run the way its step reads it. */
  private async give(child: RunEntity, text: string, idempotencyKey: string): Promise<void> {
    if (SUBTASK_ASKING_STEPS.includes(child.currentStep)) await this.reply(child, text);
    else await this.send(child, text, idempotencyKey);
  }

  /**
   * Records the answer in the subtask's own chat, where its step reads it, closes the question and starts the step
   * again. A start that was refused leaves the answer recorded, so the next pass sends the start again.
   */
  private async reply(child: RunEntity, text: string): Promise<void> {
    const [question] = await this.chat.pendingQuestions(child.key);
    if (question) {
      await this.chat.appendEntry(child.key, {
        key: `answer-${question.key}`,
        role: 'planner',
        kind: 'answer',
        from: question.from,
        text,
        at: this.clock.iso(),
        state: 'pending',
      });
      await this.chat.markTaken(child.key, [question.key]);
    }
    const answer = await this.chat.answerFor(child.key, child.currentStep);
    if ((await this.documents.latestBody(child.key, ARTIFACTS.questions.kind))?.trim()) {
      await this.documents.putDocument(child, ARTIFACTS.questions.kind, '');
    }
    await this.commands.accept('resume', child.key, {}, { idempotencyKey: `subtask-${answer?.key ?? child.key}` });
  }

  private async send(child: RunEntity, text: string, idempotencyKey: string): Promise<void> {
    const answers = openQuestions(await this.askedBody(child), await storedAsks(this.documents, child.key)).map(
      (id) => ({ kind: 'question', id, body: text }),
    );
    await this.commands.submit('answer', child.key, { answers }, { idempotencyKey });
  }

  /** The questions a child waits on: those of its research, the one of its code review, or the one of its implement. */
  private async askedBody(run: RunEntity): Promise<string> {
    if (SUBTASK_ASKING_STEPS.includes(run.currentStep)) {
      return renderQuestions((await this.chat.pendingQuestions(run.key)).map((question) => question.text));
    }
    const asked = run.currentStep === 'code-review' ? ARTIFACTS.reviewQuestions : ARTIFACTS.questions;
    return (await this.documents.latestBody(run.key, asked.kind)) ?? '';
  }

  /**
   * A follow-up visit of the plan step in the chat of the parent, recorded like any visit of that step. It is a turn of the parent's
   * planner, ordered with the others. Null when the planner gave no usable answer.
   */
  async askAbout(opened: OpenedStep, task: Subtask, questions: string, contract: string): Promise<string | null> {
    const turn = { id: `subtask-${task.id}`, at: opened.startedAt, text: questions };
    const visit = await this.conversation.ordered(opened.run.key, turn, () =>
      this.conversation.visit(
        opened,
        (received) => subtaskAsks(task, questions, contract, received),
        subtaskAnswer,
        (value) => ((value as SubtaskAnswerResult).answer.trim() ? [] : ['answer: give the decisions']),
      ),
    );
    if (!visit) return null;
    const given = visit.value as SubtaskAnswerResult;
    await this.documents.putDocument(
      opened.run,
      ARTIFACTS.subtaskAnswerResult.kind,
      ARTIFACTS.subtaskAnswerResult.format(given),
    );
    return given.answer.trim();
  }
}
