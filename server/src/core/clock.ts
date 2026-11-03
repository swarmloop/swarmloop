/** Reads the current time. Services inject it so tests can control time. */
export abstract class Clock {
  abstract now(): number;
  abstract iso(): string;
}

export class SystemClock extends Clock {
  now(): number {
    return Date.now();
  }

  iso(): string {
    return new Date().toISOString();
  }
}
