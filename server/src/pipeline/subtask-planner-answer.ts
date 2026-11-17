import { Logger } from '@nestjs/common';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import type { Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import { openQuestions, unanswered } from '../steps/shared/answers';
import { storedAsks } from './stored-research';
import { subtaskAsks } from '../steps/plan/plan.prompts';
import { subtaskAnswer, type SubtaskAnswerResult } from '../agent-result/definitions/subtask-answer';
import type { OpenedStep } from '../steps/step-run';
import type { CommandService } from './command.service';

const ASKING_STEPS: string[] = ['research', 'code-review'];

/** The parent planner's answer to the questions of a subtask's research. */
export class SubtaskPlannerAnswer {
  private readonly logger = new Logger(SubtaskPlannerAnswer.name);
  /** The planner's reply per subtask run whose delivery was refused, so a retry sends it again and does not ask again. */
  private readonly undelivered = new Map<string, string>();

  constructor(
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly conversation: PlanConversation,
    private readonly visits: VisitRepository,
  ) {}

  async asking(run: RunEntity): Promise<boolean> {
    if (run.status !== 'waiting' || !ASKING_STEPS.includes(run.currentStep)) return false;
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
    if (answer === null) return null;
    try {
      await this.send(child, answer, `subtask-answer-${child.key}-${child.revision}`);
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
      await this.send(child, text, key);
    } catch (error) {
      this.logger.warn(`${child.key} was not answered: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async send(child: RunEntity, text: string, idempotencyKey: string): Promise<void> {
    const answers = openQuestions(await this.askedBody(child), await storedAsks(this.documents, child.key)).map(
      (id) => ({ kind: 'question', id, body: text }),
    );
    await this.commands.submit('answer', child.key, { answers }, { idempotencyKey });
  }

  /** The questions a child waits on: those of its research, or the one of its code review. */
  private async askedBody(run: RunEntity): Promise<string> {
    const asked = run.currentStep === 'code-review' ? ARTIFACTS.reviewQuestions : ARTIFACTS.questions;
    return (await this.documents.latestBody(run.key, asked.kind)) ?? '';
  }

  /**
   * A follow-up visit of the plan step in the chat of the parent, recorded like any visit of that step. The pass
   * already holds the parent, so nothing else uses the chat meanwhile. Null when the planner gave no usable answer.
   */
  async askAbout(opened: OpenedStep, task: Subtask, questions: string, contract: string): Promise<string | null> {
    const visit = await this.conversation.visit(
      opened,
      (received) => subtaskAsks(task, questions, contract, received),
      subtaskAnswer,
      (value) => ((value as SubtaskAnswerResult).answer.trim() ? [] : ['answer: give the decisions']),
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
