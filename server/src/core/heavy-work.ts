export type HeavyKind = 'check' | 'setup' | 'agent';

/** A piece of work that takes real CPU and memory from the machine: a check command, a setup or an agent container. */
export interface HeavyWork {
  kind: HeavyKind;
  /** What the footprint is learned by: the check command name, the setup's step, the runtime. */
  name: string;
  /** The run it belongs to, so a Stop of the run can drop it from the queue. */
  runKey: string;
  /** What a person reads in `waiting for machine resources: ...`. */
  label: string;
  /** Runs with nothing beside it, such as the retry of a check that ran out of memory. */
  alone?: boolean;
}

/** What one piece of work takes at its peak. */
export interface Footprint {
  memoryBytes: number;
}

/** The peak memory of one finished piece of work, as the resource samples record it. */
export interface FootprintPeak {
  rssBytes: number;
}

export interface FootprintSource {
  peaks(kind: HeavyKind, name: string): Promise<FootprintPeak[]>;
}
