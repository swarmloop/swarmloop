import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { PipelineResult } from '../core/pipeline-result';
import type { RunEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { Clock } from '../core/clock';
import type { PlanChatEntry } from '../contract/plan-chat';
import { PlanConversation } from '../steps/shared/plan-conversation';
import { isSubtask } from '../contract/subtask';
import { REASON } from '../contract/run-state';
import { asksParentReason } from '../steps/shared/starter-exchange';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { readPlan } from '../steps/plan/plan-record';
import { messageTurn } from './plan-chat-route';
import { closeEscalation, escalateToPerson, escalationLine, releaseAsked } from './escalation';
import type { QuestionHolds } from '../steps/shared/question-holds';
import { answered } from '../steps/shared/answers';
import { askPlanner, readPersonAnswer } from './planner-question';

/** One thing the planner is asked: a person's message now, other kinds later. */
export interface PlannerTurn {
  /** Names the event that made it, so offering it twice holds it once. */
  id: string;
  /** ISO time of the entry, UTC. The turns of a run go in this order. */
  at: string;
  text: string;
}

/** What a taken turn left: nothing to do, a reply that keeps the plan, or a plan that plan-improve has to check. */
type TurnOutcome = 'none' | 'kept' | 'changed';

/**
 * The planner's turns of each run, one at a time, in the order the entries came.
 * It holds and orders turns, takes the turn of a run after implement started, and owns the background passes it starts.
 */
@Injectable()
export class PlannerTurns implements OnModuleDestroy {
  private readonly logger = new Logger(PlannerTurns.name);
  private readonly waiting = new Map<string, PlannerTurn[]>();
  private readonly running = new Map<string, PlannerTurn>();
  private readonly passes = new Set<Promise<void>>();
  private readonly released: (() => void)[] = [];

  constructor(
    @Optional() private readonly chat?: PlanChatStore,
    @Optional() private readonly documents?: DocumentRepository,
    @Optional() private readonly conversation?: PlanConversation,
    @Optional() private readonly runs?: RunRepository,
    @Optional() private readonly clock?: Clock,
    @Optional() private readonly holds?: QuestionHolds,
  ) {
    // Every planner turn of the run, a subtask's question to its parent included, goes through this one queue.
    if (conversation) conversation.gate = this;
  }

  /** True when the planner takes a message to this run between steps: it reached implement, so its plan is amended or gains tasks. */
  takesMessages(run: RunEntity): boolean {
    const turn = messageTurn(run, { state: 'running', openItems: 0 });
    return turn === 'amend' || turn === 'add-tasks';
  }

  /**
   * Takes the person's messages of the run that wait, in one turn: `visit` runs the planner's reply and applies it.
   * Messages that stay pending after the visit are added to `declined`, so the caller does not ask for them again
   * in the same drive, and the reason is logged.
   */
  async take(key: string, visit: () => Promise<PipelineResult>, declined: Set<string>): Promise<TurnOutcome> {
    const waiting = ((await this.chat?.pending(key)) ?? []).filter((entry) => !declined.has(entry.key));
    if (waiting.length === 0) return 'none';
    for (const entry of waiting) this.offer(key, { id: entry.key, at: entry.at, text: entry.text });
    if (!this.begin(key)) return 'none';
    try {
      const result = await visit();
      const left = new Set(((await this.chat?.pending(key)) ?? []).map((entry) => entry.key));
      this.drop(key, left);
      const stayed = waiting.filter((entry) => left.has(entry.key));
      if (result.exitCode !== 0 || stayed.length > 0) {
        for (const entry of stayed) declined.add(entry.key);
        this.logger.warn(`${key}: the planner took no message yet: ${result.message}`);
        return 'none';
      }
      const requirements = await this.documents?.latestBody(key, ARTIFACTS.requirements.kind);
      return readPlan(requirements ?? null)?.decision === 'approve' ? 'kept' : 'changed';
    } finally {
      this.end(key);
    }
  }

  /**
   * What comes first for the planner of the run: a person's message it takes between steps, the question of a
   * step that waits for it, or the person's answer to a question it escalated, by the time of their entries. Turns in `declined` are not asked for again in this drive.
   */
  async next(run: RunEntity, declined: ReadonlySet<string>): Promise<'message' | 'question' | 'answer' | null> {
    const messages = this.takesMessages(run) ? ((await this.chat?.pending(run.key)) ?? []) : [];
    // A subtask's implement and implement-improve ask its own planner first, like any run.
    const questions = (await this.chat?.pendingQuestions(run.key)) ?? [];
    const first = [
      ...messages.map((entry) => ({ kind: 'message' as const, entry })),
      ...questions.map((entry) => ({ kind: 'question' as const, entry })),
      ...(await this.answeredEscalations(run)).map((entry) => ({ kind: 'answer' as const, entry })),
    ]
      .filter(({ entry }) => !declined.has(entry.key))
      .sort((a, b) => a.entry.at.localeCompare(b.entry.at))[0];
    return first?.kind ?? null;
  }

  /**
   * Answers the oldest question that waits, one turn at a time with the person's messages. True when the planner
   * answered it. Otherwise the question stays, is added to `declined`, and the reason is logged: the step keeps waiting.
   */
  async answer(key: string, declined: Set<string>): Promise<boolean> {
    const question = ((await this.chat?.pendingQuestions(key)) ?? []).find((entry) => !declined.has(entry.key));
    if (!question) return false;
    declined.add(question.key);
    const run = await this.runs?.findRun(key);
    if (!run || !this.chat || !this.conversation || !this.clock || !this.documents) return false;
    this.offer(key, { id: question.key, at: question.at, text: question.text });
    if (!this.begin(key)) return false;
    try {
      const deps = { chat: this.chat, conversation: this.conversation, clock: this.clock };
      const outcome = await askPlanner(deps, run, question);
      if (outcome.kind === 'answered') declined.delete(question.key);
      else if (outcome.kind === 'escalated') await this.escalate(run, outcome.escalation);
      else this.logger.warn(`${key}: the planner did not answer the question of ${question.from ?? 'a step'}`);
      return outcome.kind === 'answered';
    } finally {
      this.end(key);
    }
  }

  /**
   * The question goes to the person: it waits in the run's questions, and the run waits for the answer without the step.
   * A subtask never asks a person: the entry stays pending for the planner of its parent, which asks whoever started the run.
   */
  async escalate(run: RunEntity, escalation: PlanChatEntry): Promise<void> {
    if (isSubtask(run)) {
      const message = asksParentReason(escalation.from ?? 'a step');
      const waiting = await this.runs?.findRun(run.key);
      if (waiting?.status === 'waiting')
        await this.runs?.release(waiting, { status: 'waiting', reason: { code: REASON.asksPlanner, message } });
      return;
    }
    if (this.documents) await escalateToPerson(this.documents, run, escalation);
    if (this.runs) await releaseAsked(this.runs, this.holds, run.key);
  }

  /** The escalations that wait whose question the person answered, oldest first. */
  private async answeredEscalations(run: RunEntity): Promise<PlanChatEntry[]> {
    const pending = (await this.chat?.pendingEscalations(run.key)) ?? [];
    if (pending.length === 0) return [];
    const given = answered((await this.documents?.latestBody(run.key, ARTIFACTS.answers.kind)) ?? '');
    return pending.filter((entry) => (given.get(escalationLine(entry)) ?? '').trim() !== '');
  }

  /** Holds a turn for each escalation the person answered, so it is ordered with the other turns of the run. */
  async offerAnswers(key: string): Promise<void> {
    const run = await this.runs?.findRun(key);
    for (const entry of run ? await this.answeredEscalations(run) : [])
      this.offer(key, { id: entry.key, at: entry.at, text: entry.text });
  }

  /**
   * The planner reads the person's answer to the oldest escalation that was answered, one turn at a time with the
   * others, and gives the step that asked its decision. True when it did. Otherwise the escalation stays, is added to
   * `declined`, and the reason is logged: the next drive or the next answer tries again.
   */
  async settle(key: string, declined: Set<string>): Promise<boolean> {
    const run = await this.runs?.findRun(key);
    const escalation = run
      ? (await this.answeredEscalations(run)).find((entry) => !declined.has(entry.key))
      : undefined;
    if (!run || !escalation || !this.chat || !this.conversation || !this.clock || !this.documents) return false;
    declined.add(escalation.key);
    this.offer(key, { id: escalation.key, at: escalation.at, text: escalation.text });
    if (!this.begin(key)) return false;
    try {
      const line = escalationLine(escalation);
      const person = answered((await this.documents.latestBody(key, ARTIFACTS.answers.kind)) ?? '').get(line) ?? '';
      const asked = escalation.key.slice('escalate-'.length);
      const { entries } = await this.chat.read(key);
      const question = entries.find((entry) => entry.key === asked) ?? { ...escalation, key: asked, text: '' };
      const deps = { chat: this.chat, conversation: this.conversation, clock: this.clock };
      const outcome = await readPersonAnswer(deps, run, escalation, question, person);
      if (outcome.kind !== 'answered') {
        this.logger.warn(
          `${key}: the planner did not read the answer to the question of ${escalation.from ?? 'a step'}`,
        );
        return false;
      }
      await closeEscalation(this.documents, run, escalation);
      await this.chat.markTaken(key, [escalation.key]);
      declined.delete(escalation.key);
      return true;
    } finally {
      this.end(key);
    }
  }

  /** True while a step's question waits for the planner, or an escalated question for the person's answer. */
  async hasQuestion(key: string): Promise<boolean> {
    return (
      ((await this.chat?.pendingQuestions(key)) ?? []).length > 0 ||
      ((await this.chat?.pendingEscalations(key)) ?? []).length > 0
    );
  }

  /** Runs `work` as a pass of its own. It ends before the module closes. */
  background(work: () => Promise<void>): void {
    const pass = work().catch((error: unknown) => {
      this.logger.warn(`planner pass failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.passes.add(pass);
    void pass.then(() => this.passes.delete(pass));
  }

  /** Resolves once every background pass that started has ended. */
  async idle(): Promise<void> {
    await Promise.all([...this.passes]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.idle();
  }

  /** Drops the held turns whose messages are no longer pending. */
  private drop(key: string, pending: ReadonlySet<string>): void {
    const kept = (this.waiting.get(key) ?? []).filter((turn) => pending.has(turn.id));
    if (kept.length > 0) this.waiting.set(key, kept);
    else this.waiting.delete(key);
  }

  /** Holds the turn after every held turn that is not later. A turn that is held or running is held once. */
  offer(runKey: string, turn: PlannerTurn): void {
    const queue = this.waiting.get(runKey) ?? [];
    if (this.running.get(runKey)?.id === turn.id || queue.some((held) => held.id === turn.id)) {
      return;
    }
    const later = queue.findIndex((held) => held.at > turn.at);
    queue.splice(later < 0 ? queue.length : later, 0, turn);
    this.waiting.set(runKey, queue);
  }

  /** The turns that wait, in order. */
  pending(runKey: string): PlannerTurn[] {
    return [...(this.waiting.get(runKey) ?? [])];
  }

  /** Starts the first waiting turn and returns it. Null while a turn of the run runs or none waits. */
  begin(runKey: string): PlannerTurn | null {
    const queue = this.waiting.get(runKey);
    const first = this.running.has(runKey) ? undefined : queue?.shift();
    if (!first) {
      return null;
    }
    if (queue?.length === 0) this.waiting.delete(runKey);
    this.running.set(runKey, first);
    return first;
  }

  /** Ends the running turn, so the next one can begin. */
  end(runKey: string): void {
    this.running.delete(runKey);
    for (const wake of this.released.splice(0)) wake();
  }

  /** Runs `work` as a turn of the run once no other turn of it runs; turns that wait go in the order they asked. */
  async exclusive<T>(runKey: string, turn: PlannerTurn, work: () => Promise<T>): Promise<T> {
    while (this.running.has(runKey)) await new Promise<void>((wake) => this.released.push(wake));
    this.running.set(runKey, turn);
    try {
      return await work();
    } finally {
      this.end(runKey);
    }
  }

  /** True while a turn of the run runs. */
  replying(runKey: string): boolean {
    return this.running.has(runKey) || (this.conversation?.isReplying(runKey) ?? false);
  }
}
