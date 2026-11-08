import type { CommandInput } from './command';
import type { RunAction, RunState, StateReason } from './run-state';

export interface RunSummary {
  key: string;
  name: string;
  status: string;
  currentStep: string;
  createdAt: string;
  updatedAt: string;
  stepStartedAt: string | null;
  durationMs: number;
  usd: number;
}

export interface RunsView {
  runs: RunSummary[];
}

export interface RunRef {
  key: string;
  status: string;
}

export interface FlowItem {
  kind: 'question' | 'paste';
  id: string;
  label: string;
  answer: string;
}

export interface LaunchView {
  phases: string[];
  fromStep: string | null;
  createdAt: string;
}

export interface FlowView {
  key: string;
  name: string;
  status: string;
  currentStep: string;
  updatedAt: string;
  stepStartedAt: string | null;
  resume: 'ready' | 'need-answers' | 'running' | 'blocked' | 'done';
  state: RunState;
  stateReason: StateReason | null;
  /** What the server allows now. The buttons follow it. */
  actions: RunAction[];
  revision: number;
  sentence: string;
  metrics: {
    status: string;
    durationMs: number;
    closedStarts: string[];
    tokens: number;
    usd: number;
    attemptsReview: number;
    attemptsQa: number;
    attemptsPipeline: number;
    cpuPeak: number;
    memPeak: number;
  };
  phases: { phase: string; steps: { name: string; status: string; current: boolean; attempts: number }[] }[];
  returns: { counter: string; count: number; from: string; to: 'implement' }[];
  items: FlowItem[];
  paths: { repo: string; path: string }[];
  reason: string | null;
  launches: LaunchView[];
  projects: string[];
}

export interface VisitView {
  id: number;
  /** Unique in a `StepView`: `visit-<id>` for a stored visit, `live-<step>-<attempt>` for a live one. */
  key: string;
  attempt: number;
  status: string;
  model: string | null;
  mode: string | null;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  cpuAvg: number;
  cpuPeak: number;
  memAvg: number;
  memPeak: number;
  killReason: string | null;
  decision: string | null;
  documents: { kind: string; attempt: number; body: string; createdAt: string }[];
  exchanges: { model: string; durationMs: number; request: string; response: string }[];
  samples: { at: string; cpu: number; memory: number }[];
}

/** What a step is: its kind, and the agent profile or the reviewers when it runs models. */
export interface StepDescriptor {
  name: string;
  kind: 'server' | 'agent';
  agent?: { runtime: string; model: string; mode: string; timeLimitMs: number; session: 'resume' | 'fresh' };
  reviewers?: { name: string; model: string; mode: string }[];
}

export interface StepView {
  step: string;
  visits: VisitView[];
  checks: { name: string; decision: string | null; body: string }[];
  descriptor: StepDescriptor;
  /** The last event `seq` of the run: it changes when there are new events to read. 0 means none. */
  eventsCursor: number;
}

export interface HistoryView {
  launches: LaunchView[];
  documents: { kind: string; attempt: number; body: string; createdAt: string }[];
  files: { name: string; path: string; body: string | null }[];
  exchanges: { stepStatId: number; model: string; durationMs: number; request: string; response: string }[];
  loops: { counter: string; attempt: number; reason: string; createdAt: string }[];
  calls: { method: string; url: string; statusCode: number | null; durationMs: number; error: string | null }[];
  samples: { stepStatId: number; at: string; cpu: number; memory: number }[];
  stats: {
    id: number;
    step: string;
    attempt: number;
    model: string | null;
    durationMs: number;
    usd: number;
    tokensIn: number;
    tokensOut: number;
    cpuPeak: number;
    memPeak: number;
  }[];
}

export interface ShellMount {
  hostPath: string;
  containerPath: string;
}

export interface ShellFeature {
  key: string;
  created: boolean;
  status: string;
  currentStep: string;
  runtime: string;
  resumeChatId: string | null;
  mounts: ShellMount[];
}

export interface ShellMatch {
  key: string;
  status: string;
  currentStep: string;
}

export interface TicketKeysBody {
  prompt: string;
  key?: string;
}

export interface TicketKeysView {
  keys: string[];
}

export interface CreateRunBody extends CommandInput {
  key?: string;
  prompt?: string;
  path?: string;
  projects?: string[];
  phases?: string[];
}

export interface StartStepBody extends CommandInput {
  prompt?: string;
  path?: string;
}

export interface ReplayBody extends CommandInput {
  prompt?: string;
  phases?: string[];
}

export interface ResumeBody extends CommandInput {
  prompt?: string;
}

export interface AnswersBody extends CommandInput {
  answers?: { kind?: string; id?: string; body?: string }[];
}

export interface AddProjectBody extends CommandInput {
  name?: string;
}

export interface ChatBody extends CommandInput {
  prompt?: string;
  skill?: string;
  cwd?: string;
  mcpServers?: unknown;
}

export interface OpenShellBody extends CommandInput {
  path?: string;
}

export interface LockShellBody extends CommandInput {
  container?: string;
}

export interface RewindBody extends CommandInput {
  id?: number;
}

export interface RemovedRunView {
  key: string;
}

export interface ShellStatusView {
  status: string;
}

export interface SnapshotsView {
  snapshots: { id: number; step: string; at: string }[];
}

export interface RewindView {
  step: string;
}

export interface ProjectsView {
  projects: string[];
  applied: boolean;
}

export interface ChatView {
  text: string;
}
