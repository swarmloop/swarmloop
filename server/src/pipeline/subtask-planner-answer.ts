import { createHash } from 'node:crypto';
import type { Clock } from '../core/clock';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { LookStart } from '../steps/shared/look-start';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import type { Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import { openQuestions, unanswered } from '../steps/shared/answers';
import { renderQuestions } from '../steps/research/research-record';
import { SUBTASK_ASKING_STEPS } from '../steps/implement/implement-question';
import { asksForStarter } from '../steps/shared/starter-asks';
import { storedAsks } from './stored-research';
import { subtaskAsks } from '../steps/plan/plan.prompts';
import { starterAnswer, type StarterAnswerResult } from '../agent-result/definitions/starter-answer';
import {
  applyStarterAnswer,
  decisionErrors,
  type StarterPlan,
  type StarterState,
} from '../steps/implement/starter-actions';
import { handBackErrors } from '../steps/shared/hand-back';
import { renderNeeds } from '../steps/shared/needs';
import { askPerson } from '../steps/shared/person-questions';
import { readAnsweredQuestions, readStoredQuestions, type PlannerLine } from '../steps/shared/question-parts';
import { askedQuestion } from '../steps/implement/split-questions';
import { isEscalated, type Delivery, type Escalated } from '../steps/shared/subtask-ops';
import type { OpenedStep } from '../steps/step-run';
import type { CommandService } from './command.service';
import { reviewAnswerKey } from '../steps/shared/review-answer-key';
import type { StartGate } from './start-gate';
import { PartDelivery } from './part-delivery';

const ASKING_STEPS: string[] = ['research', 'plan', 'code-review', ...SUBTASK_ASKING_STEPS];

/**
 * The parent planner's answer to the questions of a subtask: those of its research, plan and code review, which the
 * person's Answer command closes, and what the planner of its implement or implement-improve escalated, which waits
 * in the subtask's own chat for its starter.
 */
export class SubtaskPlannerAnswer {
  /** The one way a start reaches a part: a start the door refuses as held is stored on the part. */
  readonly deliveries: PartDelivery;

  constructor(
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly gate: StartGate,
    private readonly conversation: PlanConversation,
  ) {
    this.deliveries = new PartDelivery(documents);
    this.chat = conversation.chat;
    this.clock = conversation.clock;
  }

  private readonly chat: PlanChatStore;
  private readonly clock: Clock;

  async asking(run: RunEntity): Promise<boolean> {
    if (await this.handedUp(run)) return true;
    if (run.status !== 'waiting' || !ASKING_STEPS.includes(run.currentStep)) return false;
    if (SUBTASK_ASKING_STEPS.includes(run.currentStep)) return (await this.chatQuestionOf(run)) !== null;
    const questions = await this.askedBody(run);
    const answers = (await this.documents.latestBody(run.key, ARTIFACTS.answers.kind)) ?? '';
    return unanswered(questions, await storedAsks(this.documents, run.key), answers).length > 0;
  }

  /**
   * True when the run has asks nobody answered that it does not wait on: its planner handed them up from a person's
   * message and the task went on. The decision reaches the contract; nothing is resumed.
   */
  private async handedUp(run: RunEntity): Promise<boolean> {
    const waitingOnThem = run.status === 'waiting' && SUBTASK_ASKING_STEPS.includes(run.currentStep);
    return !waitingOnThem && asksForStarter(await this.chat.read(run.key)).length > 0;
  }

  /**
   * Asks the planner what a subtask asked, and sends the child its decision, or makes it wait for the tasks the answer
   * names. Null, with nothing sent, when the planner gave no usable answer. An escalation is handed up with the
   * questions the subtask holds, as no usable answer is, and returned: nothing is sent either.
   */
  async answer(
    opened: OpenedStep,
    child: RunEntity,
    task: Subtask,
    contract: string,
    plan?: StarterPlan,
    start?: LookStart,
  ): Promise<StarterAnswerResult | Escalated | null> {
    const questions = await this.askedBody(child);
    const given = await this.askAbout(opened, task, questions, contract, plan, start);
    if (given === null || isEscalated(given)) {
      // The person who started the run is asked next, from the questions the subtask holds.
      if (SUBTASK_ASKING_STEPS.includes(child.currentStep) || (await this.handedUp(child))) {
        await this.documents.putDocument(child, ARTIFACTS.questions.kind, questions);
      }
      return given;
    }
    if (given.waitFor?.length) {
      await this.waitOn(child, given);
      return given;
    }
    await this.reply(child, given);
    return given;
  }

  /**
   * Puts a question of a task among the questions the parent holds for the person who started the run, as the parent's
   * own pass does for a question its planner could not answer. The person's answer reaches the task through that pass.
   * The lines of the planners that tried follow the question. Gives the answer the person gave before when there is one,
   * and puts nothing.
   */
  async handUp(parent: RunEntity, taskId: string, text: string, lines: PlannerLine[]): Promise<string | null> {
    const held = {
      lines: openQuestions((await this.documents.latestBody(parent.key, ARTIFACTS.subtaskQuestions.kind)) ?? '', []),
      parts: readStoredQuestions((await this.documents.latestBody(parent.key, ARTIFACTS.questionParts.kind)) ?? ''),
      answered: readAnsweredQuestions(
        (await this.documents.latestBody(parent.key, ARTIFACTS.answeredQuestions.kind)) ?? '',
      ),
    };
    const result = askPerson(held, askedQuestion(taskId, text, this.clock.iso(), lines));
    if (result.kind === 'answered') return result.answer;
    await this.documents.putDocument(parent, ARTIFACTS.subtaskQuestions.kind, renderQuestions(result.lines));
    await this.documents.putDocument(
      parent,
      ARTIFACTS.questionParts.kind,
      ARTIFACTS.questionParts.format(result.parts),
    );
    return null;
  }

  /**
   * The planner's typed decision on a reviewer's finding, as an answer entry of the subtask's own chat that its
   * code-review settles by. The key names the ask document it answers, so a resend writes it once.
   */
  private async recordFinding(child: RunEntity, given: StarterAnswerResult): Promise<void> {
    if (!given.finding || child.currentStep !== 'code-review') return;
    const asked = await this.documents.latestDocument(child.key, ARTIFACTS.reviewQuestions.kind);
    if (!asked) return;
    await this.chat.appendEntry(child.key, {
      key: reviewAnswerKey(asked.id),
      role: 'planner',
      kind: 'answer',
      from: 'code-review',
      finding: given.finding,
      text: given.decision.trim(),
      at: this.clock.iso(),
      state: 'pending',
    });
  }

  /** Delivers the decision of the answer to the child. A start the door refuses as held is stored on the child. */
  private async reply(child: RunEntity, given: StarterAnswerResult): Promise<Delivery> {
    await this.recordFinding(child, given);
    const decision = given.decision.trim();
    return this.give(child, decision, await this.eventKey('subtask-answer', child, decision));
  }

  /**
   * The child waits for the tasks of the answer instead of going on: its question is closed and its needs are stored,
   * so the parent's needs path adds the dependencies and starts it again when they are merged.
   */
  private async waitOn(child: RunEntity, given: StarterAnswerResult): Promise<void> {
    await this.close(child, given.decision.trim());
    await this.documents.putDocument(child, ARTIFACTS.needs.kind, renderNeeds(given.waitFor ?? []));
  }

  /** Sends the child the answer of the person to its open questions. */
  async deliver(child: RunEntity, text: string): Promise<Delivery> {
    return this.give(child, text, await this.eventKey('subtask-person-answer', child, text));
  }

  /** The key of an answer names the event: the questions the child asked and the text that answers them. */
  private async eventKey(prefix: string, child: RunEntity, text: string): Promise<string> {
    const digest = createHash('sha256')
      .update(JSON.stringify([await this.askedBody(child), text]))
      .digest('hex');
    return `${prefix}-${child.key}-${digest}`;
  }

  /** What a subtask's own planner escalated that waits in its chat for the starter, or the answer that waits to be read; null for neither. */
  private async chatQuestionOf(run: RunEntity): Promise<PlanChatEntry | null> {
    const [ask] = asksForStarter(await this.chat.read(run.key));
    return ask ?? (await this.chat.answerFor(run.key, run.currentStep));
  }

  /** Delivers the answer to a subtask run the way its step reads it. */
  private async give(child: RunEntity, text: string, idempotencyKey: string): Promise<Delivery> {
    if (await this.handedUp(child)) {
      await this.close(child, text);
      return 'sent';
    }
    if (SUBTASK_ASKING_STEPS.includes(child.currentStep)) return this.resume(child, text);
    return this.send(child, text, idempotencyKey);
  }

  /**
   * Records the answer in the subtask's own chat, where its step reads it, closes what the step asked and starts the step
   * again, as the start of the planner of `level` that answered. A start that the door refuses as held is stored on the
   * child, and one that the gate holds back for a run a person stopped is not sent: the answer stays recorded either way.
   */
  private async resume(child: RunEntity, text: string, level = 0): Promise<Delivery> {
    await this.close(child, text);
    const answer = await this.chat.answerFor(child.key, child.currentStep);
    const key = `subtask-${answer?.key ?? child.key}`;
    const record = { type: 'resume', key, by: 'planner', level } as const;
    return this.deliveries.start(child, record, () => this.gate.resume(child, { by: 'planner', level, event: key }));
  }

  /** Records the answer in the subtask's own chat and closes what the step asked, without starting the step. */
  private async close(child: RunEntity, text: string): Promise<void> {
    const asks = asksForStarter(await this.chat.read(child.key));
    const [ask] = asks;
    if (ask) {
      await this.chat.appendEntry(child.key, {
        key: `answer-${ask.key}`,
        role: 'planner',
        kind: 'answer',
        from: ask.from,
        text,
        at: this.clock.iso(),
        state: 'pending',
      });
      await this.chat.markTaken(
        child.key,
        asks.filter((item) => item.from === ask.from).map((item) => item.key),
      );
    }
    if ((await this.documents.latestBody(child.key, ARTIFACTS.questions.kind))?.trim()) {
      await this.documents.putDocument(child, ARTIFACTS.questions.kind, '');
    }
  }

  private async send(child: RunEntity, text: string, key: string): Promise<Delivery> {
    const answers = openQuestions(await this.askedBody(child), await storedAsks(this.documents, child.key)).map(
      (id) => ({ kind: 'question', id, body: text }),
    );
    const record = { type: 'answer', key, by: 'planner', level: null, answers } as const;
    return this.deliveries.start(child, record, () =>
      this.commands.submit('answer', child.key, { answers }, { idempotencyKey: key }),
    );
  }

  /** The questions a child waits on: those of its research or plan, the one of its code review, or what its implement escalated. */
  private async askedBody(run: RunEntity): Promise<string> {
    if (SUBTASK_ASKING_STEPS.includes(run.currentStep) || (await this.handedUp(run))) {
      return renderQuestions(asksForStarter(await this.chat.read(run.key)).map((ask) => ask.text));
    }
    const asked = run.currentStep === 'code-review' ? ARTIFACTS.reviewQuestions : ARTIFACTS.questions;
    return (await this.documents.latestBody(run.key, asked.kind)) ?? '';
  }

  /**
   * A follow-up visit of the plan step in the chat of the parent, recorded like any visit of that step. It is a turn of the parent's
   * planner, ordered with the others. With a plan the planner may act on the task list, and a refused action goes back
   * to it in the same visit. The question and the decision are entries of the parent's chat; an escalation is an entry
   * of kind `escalation` instead of the decision. Null when the planner gave no usable answer.
   */
  async askAbout(
    opened: OpenedStep,
    task: Subtask,
    questions: string,
    contract: string,
    plan?: StarterPlan,
    start?: LookStart,
  ): Promise<StarterAnswerResult | Escalated | null> {
    const turn = { id: `subtask-${task.id}`, at: opened.startedAt, text: questions };
    const state: StarterState | null = plan ? { contract, ...plan, asker: task.id } : null;
    const visit = await this.conversation.ordered(opened.run.key, turn, () =>
      this.conversation.visit(
        opened,
        (received) => subtaskAsks(task, questions, contract, received, plan?.tasks),
        starterAnswer,
        (value) => {
          const given = value as StarterAnswerResult | Escalated;
          if (isEscalated(given)) return [];
          return state
            ? [...handBackErrors(questions, given), ...applyStarterAnswer(state, given, opened.startedAt).errors]
            : decisionErrors(given, false);
        },
        [questions],
        start,
        false,
        'answer-part',
      ),
    );
    if (!visit || 'refused' in visit) return null;
    const given = visit.value as StarterAnswerResult | Escalated;
    if (!isEscalated(given)) {
      await this.documents.putDocument(
        opened.run,
        ARTIFACTS.starterAnswerResult.kind,
        ARTIFACTS.starterAnswerResult.format(given),
      );
    }
    await this.record(opened, task, questions, given);
    return isEscalated(given) ? { escalate: given.escalate } : given;
  }

  /**
   * The question and its decision, or its escalation, as entries of the parent's plan chat, so its plan window shows
   * them. The escalation's key names the ask, so a replay hands it up once.
   */
  private async record(
    opened: OpenedStep,
    task: Subtask,
    questions: string,
    given: StarterAnswerResult | Escalated,
  ): Promise<void> {
    const key = opened.run.key;
    const at = this.clock.iso();
    const entry = { role: 'planner', state: 'taken', at } as const;
    const ask = `ask-${task.id}-${opened.startedAt}`;
    await this.chat.appendEntry(key, {
      ...entry,
      key: ask,
      kind: 'question',
      text: `Subtask ${task.id} asks: ${questions.trim()}`,
    });
    const answer = isEscalated(given)
      ? { key: `escalate-${ask}`, kind: 'escalation' as const, text: given.escalate.trim() }
      : { key: `decision-${task.id}-${opened.startedAt}`, kind: 'answer' as const, text: given.decision.trim() };
    await this.chat.appendEntry(key, { ...entry, ...answer });
  }
}
