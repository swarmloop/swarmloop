import { Injectable } from '@nestjs/common';
import { HaltedRuns } from '../core/halted-runs';

/** Runs the user asked to stop. A crash retry checks this before starting again. */
@Injectable()
export class RunStop extends HaltedRuns {
  private readonly keys = new Set<string>();
  private readonly listeners: ((key: string) => void)[] = [];

  halt(key: string): void {
    this.keys.add(key);
    this.listeners.forEach((listener) => listener(key));
  }

  onHalted(listener: (key: string) => void): void {
    this.listeners.push(listener);
  }

  clear(key: string): void {
    this.keys.delete(key);
  }

  halted(key: string): boolean {
    return this.keys.has(key);
  }
}
