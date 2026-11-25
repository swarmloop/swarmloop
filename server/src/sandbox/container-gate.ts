import { Injectable, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { agentPlaceText } from '../contract/agent-place';
import { STOP_NOTE, REASON } from '../contract/run-state';
import type { StateReason } from '../contract/run-state';
import { SERVER_PAUSE_NOTE } from '../contract/server-pause';

type Listener = (paused: boolean) => void;

interface Held {
  key: string;
  /** The start is an agent's: a check held by the pause is not. */
  agent: boolean;
  go: () => void;
  drop: (error: ContainerDropped) => void;
}

/** An agent container waits for a place: `onWait` is told, once, how many places are busy. */
export interface AgentHold {
  /** The step the agent is for, as its chip names it. */
  step: string;
  onWait: (text: string) => void;
}

interface HeldAgent extends Held {
  step: string;
  onPaused: () => void;
}

/** A Stop took a container out of the line before it started. The step ends blocked, not failed. */
export class ContainerDropped extends Error {
  constructor() {
    super(STOP_NOTE);
  }
}

/**
 * The one place that decides whether a held container may start, and the count of those that run. It holds starts
 * while the server is paused, and agent starts beyond AGENTS_PARALLEL, in the order they came.
 */
@Injectable()
export class ContainerGate {
  private isPaused = false;
  private open = 0;
  private waiting: Held[] = [];
  private line: HeldAgent[] = [];
  private agents = 0;
  private readonly agentsOfRun = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private readonly placeListeners = new Set<() => void>();

  constructor(@Optional() private readonly config?: AppConfig) {}

  paused(): boolean {
    return this.isPaused;
  }

  running(): number {
    return this.open;
  }

  /** What the agents of a run are doing in the line: the steps that wait, its agent containers that run, and the words. */
  agentWait(key: string): { steps: string[]; running: number; text: string } {
    return {
      steps: this.line.filter((held) => held.key === key).map((held) => held.step),
      running: this.agentsOfRun.get(key) ?? 0,
      text: agentPlaceText(this.agents, this.limit()),
    };
  }

  /**
   * What the agent starts of a run wait for now, in one rule: nothing while one of its agents runs; the server's pause
   * while the server is paused and a start of the run is held; a free place while one waits in the line.
   */
  startWait(key: string): StateReason | null {
    if ((this.agentsOfRun.get(key) ?? 0) > 0) {
      return null;
    }
    const inLine = this.line.some((held) => held.key === key);
    if (this.isPaused && (inLine || this.waiting.some((held) => held.key === key && held.agent))) {
      return { code: REASON.serverPause, message: SERVER_PAUSE_NOTE };
    }
    return inLine ? { code: REASON.agentPlace, message: agentPlaceText(this.agents, this.limit()) } : null;
  }

  /** An agent that already waits for a place is told of the pause too: no place is handed out until it ends. */
  pause(): void {
    if (this.flip(true)) {
      for (const held of this.line) {
        held.onPaused();
      }
    }
  }

  /** Lets the held starts through in the order they came. */
  resume(): void {
    if (!this.flip(false)) {
      return;
    }
    const release = this.waiting;
    this.waiting = [];
    for (const held of release) {
      held.go();
    }
    this.startLine();
  }

  /** Takes every container of a run out of the wait. It rejects them; the ones already admitted stay. */
  drop(key: string): void {
    const dropped = this.waiting.filter((held) => held.key === key);
    this.waiting = this.waiting.filter((held) => held.key !== key);
    const droppedAgents = this.line.filter((held) => held.key === key);
    this.line = this.line.filter((held) => held.key !== key);
    for (const held of [...dropped, ...droppedAgents]) {
      held.drop(new ContainerDropped());
    }
  }

  /**
   * Resolves at once when not paused. When paused it says so once and resolves after the pause ends.
   * An agent (`agent` given) then waits in a line while AGENTS_PARALLEL agent containers run, and says so once.
   * `key` is the run the container is for, so a Stop can take it out of the wait. The container counts from here until the returned release is called, which is safe to call twice.
   */
  async admit(onPaused: () => void, key: string, agent?: AgentHold): Promise<() => void> {
    if (this.isPaused) {
      onPaused();
      await new Promise<void>((go, drop) => this.waiting.push({ key, agent: agent !== undefined, go, drop }));
    }
    if (agent) {
      await this.takePlace(key, agent, onPaused);
    }
    this.open += 1;
    let counted = true;
    return () => {
      if (counted) {
        counted = false;
        this.open -= 1;
        if (agent) {
          this.leave(key);
        }
      }
    };
  }

  /** The runs that have an agent start held by the pause or waiting in the line. */
  waitingKeys(): string[] {
    const held = this.waiting.filter((entry) => entry.agent).map((entry) => entry.key);
    return [...new Set([...held, ...this.line.map((entry) => entry.key)])];
  }

  /** Told after an agent place was given back and the line moved on, so what each run waits for may have changed. */
  onPlaces(listener: () => void): () => void {
    this.placeListeners.add(listener);
    return () => this.placeListeners.delete(listener);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private limit(): number {
    return this.config?.env.AGENTS_PARALLEL ?? Infinity;
  }

  private async takePlace(key: string, agent: AgentHold, onPaused: () => void): Promise<void> {
    if (this.agents < this.limit() && this.line.length === 0) {
      this.enter(key);
      return;
    }
    agent.onWait(agentPlaceText(this.agents, this.limit()));
    await new Promise<void>((go, drop) => this.line.push({ key, agent: true, step: agent.step, onPaused, go, drop }));
  }

  private enter(key: string): void {
    this.agents += 1;
    this.agentsOfRun.set(key, (this.agentsOfRun.get(key) ?? 0) + 1);
  }

  private leave(key: string): void {
    this.agents -= 1;
    const left = (this.agentsOfRun.get(key) ?? 1) - 1;
    if (left > 0) {
      this.agentsOfRun.set(key, left);
    } else {
      this.agentsOfRun.delete(key);
    }
    this.startLine();
    for (const listener of this.placeListeners) {
      listener();
    }
  }

  /** Starts the head of the line while a place is free, and never while the server is paused. */
  private startLine(): void {
    while (!this.isPaused && this.agents < this.limit()) {
      const next = this.line.shift();
      if (!next) {
        return;
      }
      this.enter(next.key);
      next.go();
    }
  }

  private flip(paused: boolean): boolean {
    if (this.isPaused === paused) {
      return false;
    }
    this.isPaused = paused;
    for (const listener of this.listeners) {
      listener(paused);
    }
    return true;
  }
}
