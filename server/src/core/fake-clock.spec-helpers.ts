import { Clock } from './clock';

/** A clock that stands still until a spec advances it. */
export class FakeClock extends Clock {
  private current: number;

  constructor(start = Date.UTC(2026, 0, 1)) {
    super();
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  iso(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
