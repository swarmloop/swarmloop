import type { CommandInput } from './command';
import type { RunAction, RunState, StateReason } from './run-state';
import type { SubtaskStatus } from './subtask';

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
  /** Set on a subtask only: the key of its parent run and its task id. */
  parentKey?: string;
  taskId?: string;
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

/** The tasks that can start together once the layers before them are done. */
export interface TaskLayer {
  layer: number;
  tasks: { id: string; title: string; files: string[]; proof: string; status: SubtaskStatus; note?: string }[];
}

export interface FlowView {
  key: string;
  name: string;
  status: string;
  currentStep: string;
  updatedAt: string;
  stepStartedAt: string | null;
  /** Set on a subtask only: the key of its parent run. */
  parentKey?: string;
  /** Who started the run. Missing for a run the CLI started and for runs from before logins. */
  startedBy?: string;
  /** The tasks of a split plan after plan-improve, by dependency layer. Missing when the run does not split. */
  tasks?: TaskLayer[];
  /** `4/7 merged · 2 running · 1 waiting`, once the run is at implement or past it. Missing when the run does not split. */
  taskLine?: string;
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
    attemptsChecks: number;
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
  /** `removed` after retention took the worktrees of a done run; the next action recreates them. */
  workspace: 'removed' | null;
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
  /** The attempt whose log this visit wrote, for `GET /runs/:key/steps/:step/log?attempt=`. Null when it has none. */
  attemptId: string | null;
  logBytes: number;
  logLines: number;
  documents: { kind: string; attempt: number; body: string; createdAt: string }[];
  exchanges: { model: string; durationMs: number; request: string; response: string }[];
  /** `source` is `agent`, `setup`, or the index of the check command whose container was sampled. */
  samples: { at: string; cpu: number; memory: number; source: string }[];
}

/** What a step is: its kind, and the agent profile or the reviewers when it runs models. */
export interface StepDescriptor {
  name: string;
  kind: 'server' | 'agent';
  agent?: {
    runtime: string;
    model: string;
    mode: string;
    tools: 'read' | 'plan' | 'write';
    timeLimitMs: number;
    session: 'resume' | 'fresh';
    /** The role the step's agent plays, and `subtask` for a run with a parent. */
    role?: 'plan' | 'implement' | 'review';
    tier?: 'main' | 'subtask';
  };
  reviewers?: { name: string; model: string; mode: string }[];
}

/** One command of a checks visit. Its full output is at `GET /runs/:key/steps/checks/log?attempt=&command=<index>`. */
export interface CheckCommandView {
  /** The attempt id of the checks visit, as `VisitView.attemptId`. */
  attempt: string;
  index: number;
  repo: string;
  command: string;
  status: 'waiting' | 'running' | 'passed' | 'failed' | 'skipped';
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
}

export interface StepView {
  step: string;
  visits: VisitView[];
  /** The commands of every checks visit. Only the `checks` step has them. */
  commands?: CheckCommandView[];
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
  samples: { stepStatId: number; at: string; cpu: number; memory: number; source: string }[];
  stats: {
    /** What `VisitView` says of a visit's log. A stored visit's attempt is where to read it. */
    attemptId: string | null;
    logBytes: number;
    logLines: number;
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
  /** May the planner split the run into subtasks. The server's `SPLIT` decides when it is missing. */
  split?: boolean;
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

export interface SkipTaskBody extends CommandInput {
  taskId?: string;
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

/** The projects a new run can use, and whether a new run may split by default (the server's `SPLIT`). */
export interface ProjectListView {
  projects: string[];
  split?: boolean;
}

export interface ProjectsView {
  projects: string[];
  applied: boolean;
}

export interface ChatView {
  text: string;
}

export type ReadinessId =
  'docker' | 'arch' | 'images' | 'disk' | 'paths' | 'ports' | 'model-credential' | 'code-host-token';

export interface ReadinessItem {
  id: ReadinessId;
  status: 'ok' | 'warn' | 'fail';
  /** One line that says what was found. */
  line: string;
  /** One next step. For an `ok` item it says there is nothing to do. */
  action: string;
}

export interface ReadinessView {
  items: ReadinessItem[];
}

/** How a run ended up, for the statistics: done, still going (running, waiting, stopped), or failed (failed, blocked). */
export type RunOutcome = 'done' | 'active' | 'failed';

/** One local day of the statistics range. Runs count by the day they started; spend and returns by the day they happened. */
export interface StatsDay {
  day: string;
  done: number;
  active: number;
  failed: number;
  usd: number;
  returns: number;
}

/** Spend and tokens of one step, model or agent. `count` is visits for steps and models, runs for agents. */
export interface StatsShare {
  name: string;
  usd: number;
  tokens: number;
  count: number;
}

export interface StatsRun {
  key: string;
  name: string;
  status: string;
  outcome: RunOutcome;
  usd: number;
  returns: number;
  durationMs: number;
  createdAt: string;
}

export interface StatsTotals {
  runs: number;
  done: number;
  active: number;
  failed: number;
  usd: number;
  tokensIn: number;
  tokensOut: number;
  /** Times a reviewer sent the work back to implementation. */
  reviewReturns: number;
  /** Times the CI pipeline sent the work back. */
  pipelineReturns: number;
  /** Done runs that never went back. */
  firstPass: number;
  /** Launches that ended on a provider usage limit. A limited launch is no attempt of its step. */
  limits: number;
  /** Time the agents worked, summed over steps. */
  agentMs: number;
  /** Median working time of a done run; null without one. */
  medianDoneMs: number | null;
}

/** The runs started from `from` to `to` (local days, inclusive) and everything they did. */
export interface StatsView {
  from: string;
  to: string;
  totals: StatsTotals;
  days: StatsDay[];
  steps: StatsShare[];
  models: StatsShare[];
  agents: StatsShare[];
  /** Who sent work back: one reviewer per entry, and `pipeline` for CI. */
  reasons: { name: string; returns: number }[];
  /** How many runs went back 0, 1, 2, 3 and 4 or more times. */
  returnsPerRun: { returns: string; runs: number }[];
  /** Every run of the range, newest first. */
  runs: StatsRun[];
}
