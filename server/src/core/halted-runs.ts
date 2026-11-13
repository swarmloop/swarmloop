/** Which runs the user asked to stop. Code outside the agent layer reads it through this port. */
export abstract class HaltedRuns {
  abstract halted(key: string): boolean;
}
