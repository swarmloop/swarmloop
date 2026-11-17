import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import type { PipelineResult } from '../core/pipeline-result';
import type { RunEntity } from '../history/entities';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { isSubtask } from '../contract/subtask';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { readPlan } from '../steps/plan/plan-record';
import { messageTurn } from './plan-chat-route';

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

  constructor(
    @Optional() private readonly chat?: PlanChatStore,
    @Optional() private readonly documents?: DocumentRepository,
  ) {}

  /** True when the planner takes a message to this run between steps: it is no subtask and reached implement, so its plan is amended or gains tasks. */
  takesMessages(run: RunEntity): boolean {
    const turn = messageTurn(run, { state: 'running', openItems: 0 });
    return !isSubtask(run) && (turn === 'amend' || turn === 'add-tasks');
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
  }

  /** True while a turn of the run runs. */
  replying(runKey: string): boolean {
    return this.running.has(runKey);
  }
}
