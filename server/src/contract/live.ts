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
}

export interface LiveLog {
  key: string;
  step: string;
  body: string;
  samples?: LiveSample[];
  usage?: LiveUsage;
}

/** Type aliases, not interfaces: socket.io's EventsMap needs an index signature that interfaces lack. */
export type ServerToClientEvents = {
  runs: (view: RunsView) => void;
  flow: (view: FlowView) => void;
  log: (entry: LiveLog) => void;
};

export type ClientToServerEvents = {
  watch: (key: string) => void;
};
