import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import type { OpenedStep } from '../steps/step-run';
import type { Subtask } from '../contract/subtask';
import type { CommandService } from './command.service';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { mergeHandoff } from '../steps/shared/handoff';
import { storedNeeds, type Need } from '../steps/shared/needs';
import { storedAsks } from './stored-research';
import { SubtaskPlannerAnswer } from './subtask-planner-answer';
import type { RunRepository } from '../history/run.repository';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { PlanChange, StarterPlan } from '../steps/implement/starter-actions';
import type { StarterAnswerResult } from '../agent-result/definitions/starter-answer';
import { buildRevision } from '../steps/shared/plan-revision';

/** The asks of subtask runs and the answers they get, as the port hands them to the implement pass. */
export class SubtaskAsks {
  private readonly planner: SubtaskPlannerAnswer;
  private readonly chat: PlanChatStore;

  constructor(
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    conversation: PlanConversation,
    private readonly visits: VisitRepository,
    private readonly runs: RunRepository,
  ) {
    this.planner = new SubtaskPlannerAnswer(documents, commands, conversation, visits);
    this.chat = conversation.chat;
  }

  asking(run: RunEntity): Promise<boolean> {
    return this.planner.asking(run);
  }

  answer(
    opened: OpenedStep,
    child: RunEntity,
    task: Subtask,
    contract: string,
    plan?: StarterPlan,
  ): Promise<StarterAnswerResult | null> {
    return this.planner.answer(opened, child, task, contract, plan);
  }

  resend(child: RunEntity): Promise<StarterAnswerResult | null> {
    return this.planner.resend(child);
  }

  /**
   * Writes each change of the task list as a plan revision with its reason, in the parent's plan chat and in the chat
   * of the task it changed, where the reviewers of that task read it. A change recorded for the same event is not written again.
   */
  async recordRevisions(parent: RunEntity, changes: PlanChange[], at: string): Promise<void> {
    for (const change of changes) {
      const child = await this.runs.findSubtask(parent, change.taskId);
      for (const key of [parent.key, ...(child ? [child.key] : [])]) {
        const { revisions } = await this.chat.read(key);
        const revision = buildRevision({ ...change, known: revisions, at });
        const event = (item: typeof revision): string =>
          JSON.stringify([item.reason, item.at, item.added, item.changed, item.dropped]);
        if (!revisions.some((known) => event(known) === event(revision))) await this.chat.appendRevision(key, revision);
      }
    }
  }

  replyPending(child: RunEntity): boolean {
    return this.planner.replyPending(child);
  }

  deliverAnswer(child: RunEntity, text: string): Promise<void> {
    return this.planner.deliver(child, text);
  }

  /** The decision of the planner to a question about a task, as text. Null when it gave no usable answer. */
  async askAbout(opened: OpenedStep, task: Subtask, questions: string, contract: string): Promise<string | null> {
    return (await this.planner.askAbout(opened, task, questions, contract))?.decision.trim() ?? null;
  }

  /** The needs a subtask run waits on, with the questions it asked. */
  async needsOf(run: RunEntity): Promise<Need[]> {
    return storedNeeds(
      (await this.documents.latestBody(run.key, ARTIFACTS.needs.kind)) ?? '',
      await storedAsks(this.documents, run.key),
    );
  }

  /** Hands the answers to the needs back to the run and resumes it; a refused resume puts the needs back. */
  async rerun(run: RunEntity, lines: string[]): Promise<void> {
    const needs = await this.documents.latestBody(run.key, ARTIFACTS.needs.kind);
    const handoff = await this.documents.latestBody(run.key, ARTIFACTS.handoff.kind);
    await this.documents.putDocument(run, ARTIFACTS.needs.kind, '');
    await this.documents.putDocument(
      run,
      ARTIFACTS.handoff.kind,
      mergeHandoff(handoff, run.currentStep, lines.join('\n')),
    );
    try {
      await this.commands.accept(
        'resume',
        run.key,
        {},
        { idempotencyKey: `subtask-needs-${run.key}-${(await this.visits.listStats(run.id)).length}` },
      );
    } catch (error) {
      await this.documents.putDocument(run, ARTIFACTS.needs.kind, needs ?? '');
      throw error;
    }
  }
}
