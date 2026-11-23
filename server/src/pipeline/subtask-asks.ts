import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { LookStart } from '../steps/shared/look-start';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import type { OpenedStep } from '../steps/step-run';
import type { Subtask } from '../contract/subtask';
import { createHash } from 'node:crypto';
import type { CommandService } from './command.service';
import type { StartGate } from './start-gate';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { mergeHandoff } from '../steps/shared/handoff';
import { storedNeeds, type Need } from '../steps/shared/needs';
import { storedAsks } from './stored-research';
import { SubtaskPlannerAnswer } from './subtask-planner-answer';
import type { RunRepository } from '../history/run.repository';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { PlanChange, StarterPlan } from '../steps/implement/starter-actions';
import type { StarterAnswerResult } from '../agent-result/definitions/starter-answer';
import type { SubtaskStart } from '../steps/shared/subtask-ops';
import { buildRevision } from '../steps/shared/plan-revision';

/** The asks of subtask runs and the answers they get, as the port hands them to the implement pass. */
export class SubtaskAsks {
  private readonly planner: SubtaskPlannerAnswer;
  private readonly chat: PlanChatStore;

  constructor(
    private readonly documents: DocumentRepository,
    commands: CommandService,
    private readonly gate: StartGate,
    conversation: PlanConversation,
    visits: VisitRepository,
    private readonly runs: RunRepository,
  ) {
    this.planner = new SubtaskPlannerAnswer(documents, commands, gate, conversation, visits);
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
    start?: LookStart,
  ): Promise<StarterAnswerResult | null> {
    return this.planner.answer(opened, child, task, contract, plan, start);
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

  handUp(parent: RunEntity, taskId: string, text: string): Promise<void> {
    return this.planner.handUp(parent, taskId, text);
  }

  /** The needs a subtask run waits on, with the questions it asked. */
  async needsOf(run: RunEntity): Promise<Need[]> {
    return storedNeeds(
      (await this.documents.latestBody(run.key, ARTIFACTS.needs.kind)) ?? '',
      await storedAsks(this.documents, run.key),
    );
  }

  /**
   * Hands the answers to the needs back to the run and resumes it, as the start it is given. The event names the needs
   * and the lines, so the same ask is one start however many visits came between. A run a person stopped is left as
   * it is; a refused or held-back resume puts the needs and the handoff back.
   */
  async rerun(run: RunEntity, lines: string[], start: SubtaskStart = { by: 'machine', level: null }): Promise<void> {
    if (await this.gate.stopped(run)) return;
    const needs = await this.documents.latestBody(run.key, ARTIFACTS.needs.kind);
    const handoff = await this.documents.latestBody(run.key, ARTIFACTS.handoff.kind);
    await this.documents.putDocument(run, ARTIFACTS.needs.kind, '');
    await this.documents.putDocument(
      run,
      ARTIFACTS.handoff.kind,
      mergeHandoff(handoff, run.currentStep, lines.join('\n')),
    );
    const digest = createHash('sha256')
      .update(JSON.stringify([needs ?? '', lines]))
      .digest('hex');
    const event = `subtask-needs-${run.key}-${digest}`;
    let resumed: Awaited<ReturnType<StartGate['resume']>>;
    try {
      resumed = await this.gate.resume(run, { by: start.by, level: start.level ?? undefined, event });
    } catch (error) {
      await this.restore(run, needs, handoff);
      throw error;
    }
    if (resumed === 'stopped') await this.restore(run, needs, handoff);
  }

  private async restore(run: RunEntity, needs: string | null, handoff: string | null): Promise<void> {
    await this.documents.putDocument(run, ARTIFACTS.needs.kind, needs ?? '');
    await this.documents.putDocument(run, ARTIFACTS.handoff.kind, handoff ?? '');
  }
}
