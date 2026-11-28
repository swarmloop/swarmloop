import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
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
import { isEscalated, type Delivery, type Escalated, type SubtaskStart } from '../steps/shared/subtask-ops';
import { buildRevision } from '../steps/shared/plan-revision';

/** The asks of subtask runs and the answers they get, as the port hands them to the implement pass. */
export class SubtaskAsks {
  private readonly planner: SubtaskPlannerAnswer;
  private readonly chat: PlanChatStore;

  constructor(
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly gate: StartGate,
    conversation: PlanConversation,
    private readonly runs: RunRepository,
  ) {
    this.planner = new SubtaskPlannerAnswer(documents, commands, gate, conversation);
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
  ): Promise<StarterAnswerResult | Escalated | null> {
    return this.planner.answer(opened, child, task, contract, plan, start);
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

  async held(child: RunEntity): Promise<boolean> {
    return (await this.planner.deliveries.held(child)) !== null;
  }

  /** Sends the start of a part again that the door refused as held: the one dispatch of a stored record. */
  async sendHeld(child: RunEntity): Promise<Delivery> {
    const record = await this.planner.deliveries.held(child);
    if (!record) return 'sent';
    const level = record.level ?? undefined;
    const send =
      record.type === 'resume'
        ? () => this.gate.resume(child, { by: record.by, level, event: record.key })
        : () =>
            this.commands.submit(
              'answer',
              child.key,
              { answers: record.answers ?? [] },
              { idempotencyKey: record.key },
            );
    return this.planner.deliveries.start(child, record, send);
  }

  deliverAnswer(child: RunEntity, text: string): Promise<Delivery> {
    return this.planner.deliver(child, text);
  }

  /** The decision of the planner to a question about a task, as text, or its escalation as it is. Null when it gave no usable answer. */
  async askAbout(
    opened: OpenedStep,
    task: Subtask,
    questions: string,
    contract: string,
  ): Promise<string | Escalated | null> {
    const given = await this.planner.askAbout(opened, task, questions, contract);
    if (given === null || isEscalated(given)) return given;
    return given.decision.trim();
  }

  handUp(parent: RunEntity, taskId: string, text: string, words?: string): Promise<void> {
    return this.planner.handUp(parent, taskId, text, words);
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
   * it is; a held-back resume puts the needs and the handoff back. A start the door refuses as held keeps what was
   * written and is stored on the run, so the epic sends it again at its next pass.
   */
  async rerun(
    run: RunEntity,
    lines: string[],
    start: SubtaskStart = { by: 'machine', level: null },
  ): Promise<Delivery> {
    if (await this.gate.stopped(run)) return 'sent';
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
    let resumed: Awaited<ReturnType<StartGate['resume']>> | undefined;
    const record = { type: 'resume', key: event, by: start.by, level: start.level } as const;
    try {
      const delivery = await this.planner.deliveries.start(run, record, async () => {
        resumed = await this.gate.resume(run, { by: start.by, level: start.level ?? undefined, event });
      });
      if (resumed === 'stopped') await this.restore(run, needs, handoff);
      return delivery;
    } catch (error) {
      await this.restore(run, needs, handoff);
      throw error;
    }
  }

  private async restore(run: RunEntity, needs: string | null, handoff: string | null): Promise<void> {
    await this.documents.putDocument(run, ARTIFACTS.needs.kind, needs ?? '');
    await this.documents.putDocument(run, ARTIFACTS.handoff.kind, handoff ?? '');
  }
}
