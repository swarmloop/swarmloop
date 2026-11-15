import { Injectable } from '@nestjs/common';
import { STOP_NOTE } from '../contract/run-state';

type Listener = (paused: boolean) => void;

interface Held {
  key: string;
  go: () => void;
  drop: (error: ContainerDropped) => void;
}

/** A Stop took a container out of the line before it started. The step ends blocked, not failed. */
export class ContainerDropped extends Error {
  constructor() {
    super(STOP_NOTE);
  }
}

/** The one place that decides whether a held container may start, and the count of those that run. */
@Injectable()
export class ContainerGate {
  private isPaused = false;
  private open = 0;
  private waiting: Held[] = [];
  private readonly listeners = new Set<Listener>();

  paused(): boolean {
    return this.isPaused;
  }

  running(): number {
    return this.open;
  }

  pause(): void {
    this.flip(true);
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
  }

  /** Takes every container of a run out of the wait. It rejects them; the ones already admitted stay. */
  drop(key: string): void {
    const dropped = this.waiting.filter((held) => held.key === key);
    this.waiting = this.waiting.filter((held) => held.key !== key);
    for (const held of dropped) {
      held.drop(new ContainerDropped());
    }
  }

  /**
   * Resolves at once when not paused. When paused it says so once and resolves after the pause ends.
   * `key` is the run the container is for, so a Stop can take it out of the wait. The container counts from here until the returned release is called, which is safe to call twice.
   */
  async admit(onPaused: () => void, key: string): Promise<() => void> {
    if (this.isPaused) {
      onPaused();
      await new Promise<void>((go, drop) => this.waiting.push({ key, go, drop }));
    }
    this.open += 1;
    let counted = true;
    return () => {
      if (counted) {
        counted = false;
        this.open -= 1;
      }
    };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
