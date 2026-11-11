import type { FlowView, RunsView } from './api';

export interface LiveUsage {
  tokensIn: number;
  tokensOut: number;
  usd: number;
}

export interface LiveSample {
  at: string;
  cpu: number;
  memory: number;
  source: string;
}

export interface LiveLog {
  key: string;
  step: string;
  body: string;
  /** The index of the check command the body belongs to. Only the checks step sets it. */
  command?: number;
  samples?: LiveSample[];
  usage?: LiveUsage;
}

/** The last event a step appended; the client reads what is new with `after`. */
export interface LiveEvents {
  key: string;
  step: string;
  seq: number;
}

/** Type aliases, not interfaces: socket.io's EventsMap needs an index signature that interfaces lack. */
export type ServerToClientEvents = {
  runs: (view: RunsView) => void;
  flow: (view: FlowView) => void;
  log: (entry: LiveLog) => void;
  events: (entry: LiveEvents) => void;
};

export type ClientToServerEvents = {
  watch: (key: string) => void;
};
