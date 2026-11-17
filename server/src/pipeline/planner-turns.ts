import { Injectable } from '@nestjs/common';

/** One thing the planner is asked: a person's message now, other kinds later. */
export interface PlannerTurn {
  /** Names the event that made it, so offering it twice holds it once. */
  id: string;
  /** ISO time of the entry, UTC. The turns of a run go in this order. */
  at: string;
  text: string;
}

/**
 * The planner's turns of each run, one at a time, in the order the entries came.
 * It holds and orders turns. Whoever runs a turn asks for the next one and ends it.
 */
@Injectable()
export class PlannerTurns {
  private readonly waiting = new Map<string, PlannerTurn[]>();
  private readonly running = new Map<string, PlannerTurn>();

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
