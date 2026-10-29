import { Injectable } from '@nestjs/common';

/** Runs the user asked to stop. A crash retry checks this before starting again. */
@Injectable()
export class RunStop {
  private readonly keys = new Set<string>();

  halt(key: string): void {
    this.keys.add(key);
  }

  clear(key: string): void {
    this.keys.delete(key);
  }

  halted(key: string): boolean {
    return this.keys.has(key);
  }
}
