/** Which runs the user asked to stop. Code outside the agent layer reads it through this port. */
export abstract class HaltedRuns {
  abstract halted(key: string): boolean;
  /** Calls `listener` with the key each time a run is halted. */
  abstract onHalted(listener: (key: string) => void): void;
}
