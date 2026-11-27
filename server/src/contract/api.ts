import type { Effort } from './effort';
import type { RunEta } from './eta';
import type { MergeOutcome, RunAction, RunState, StateReason } from './run-state';
import type { InterruptionNote } from './interruption';
import type { TaskEntry } from './task-entry';
import type { SubtaskStatus } from './subtask';
import type { RunBacklog } from './backlog';
import type { Role } from './people';
import type { ConversationView } from './plan-chat';
import type { RelaunchView } from './relaunch';

export type { SettingsBody, StoredAgents } from './settings';
export type { ConnectionView, ConnectionsView, TokenSignInView, ProvidersView } from './host-login';
export type {
  RunOutcome,
  StatsCiReturns,
  StatsDay,
  StatsReason,
  StatsRun,
  StatsShare,
  StatsTotals,
  StatsUnit,
  StatsView,
} from './stats';
export type { TaskEntry } from './task-entry';
export type {
  TicketKeysBody,
  TicketKeysView,
  CreateRunBody,
  ReplayBody,
  ResumeBody,
  AnswersBody,
  AddProjectBody,
  SkipTaskBody,
  RemovedRunView,
} from './api-bodies';

export interface RunSummary {
  key: string;
  name: string;
  /** A short title for a person: at most 70 characters, no markdown. */
  title: string;
  /** A rough estimate of the time left; absent when the run has none. */
  eta?: RunEta;
  status: string;
  currentStep: string;
  createdAt: string;
  updatedAt: string;
  stepStartedAt: string | null;
  durationMs: number;
  usd: number;
  /** Set on a done run whose merge requests were merged or closed. */
  merge?: MergeOutcome;
  /** Set on a subtask only: the key of its parent run and its task id. */
  parentKey?: string;
  taskId?: string;
  /** Set on a run a backlog task holds: the backlog and its milestone. */
  backlog?: RunBacklog;
  /** Set on a done subtask the parent has not merged yet: what the merge waits for, when it waits for something. */
  mergeWait?: string;
  /** Set on a run with subtask runs only: its own cost plus its subtasks', and the wall clock from its start to its end. */
  epic?: { usd: number; durationMs: number };
  /** The honest state of the run, the same word the run page shows. */
  state: RunState;
  /** Why the run is in that state: the limit, the outage or the block. Null when there is nothing to add. */
  stateReason: StateReason | null;
  /** Set on a subtask whose task is in its parent's plan: its place in the plan and its live status. */
  task?: { index: number; status: SubtaskStatus };
  /** Set on a run whose plan has tasks: how many tasks of the whole plan show each status. */
  taskCounts?: Partial<Record<SubtaskStatus, number>>;
}

export interface RunsView {
  runs: RunSummary[];
}

export interface RunRef {
  key: string;
  status: string;
}

/** A question that waits for a person, in parts: what is decided, each side on the point in dispute, and the whole text. */
export interface QuestionParts {
  decide: string;
  sides: { who: string; text: string }[];
  full: string;
  /** When the question was asked, as an ISO time; the dashboard shows it in local time. */
  askedAt: string;
  /** The step that asked, as the plan chat names it (`implement`, `code-review-quality`, `subtask:<task id>`); missing on older parts. */
  asker?: string;
  /** The key of the plan chat entry the question came from; missing when none. */
  entry?: string;
}

export interface FlowItem {
  kind: 'question' | 'paste';
  id: string;
  label: string;
  answer: string;
  /** Set on a question that carries its parts next to its text. */
  parts?: QuestionParts;
  /** Set on a question of a backlog's run that the backlog's planner has and has not passed on. */
  holder?: 'planner';
  /** The planner's line when it passed the question on to the person. */
  passedOn?: string;
}

/** The merge request of a run in one repository. */
export interface MergeRequestView {
  repo: string;
  url: string;
  state: 'draft' | 'open' | 'merged' | 'closed';
}

export interface LaunchView {
  phases: string[];
  fromStep: string | null;
  createdAt: string;
}

/** One decision of the contract's log, in words. The ids are for a tooltip, never for visible text. */
export interface DecisionView {
  /** The task's title, or `Plan` for a line the server wrote with no task. */
  task: string;
  /** ISO time; null when none was stored. */
  at: string | null;
  /** The decision in words, without the item id prefix. */
  text: string;
  /** The task's id; '' when none. */
  taskId: string;
  /** The contract item id the decision names; null when none. */
  item: string | null;
}

export interface FlowView {
  key: string;
  name: string;
  /** A short title for a person: at most 70 characters, no markdown. */
  title: string;
  /** A rough estimate of the time left; absent when the run has none. */
  eta?: RunEta;
  /** One merge request per repository, from the run's stored merge requests. */
  mergeRequests: MergeRequestView[];
  status: string;
  currentStep: string;
  updatedAt: string;
  stepStartedAt: string | null;
  /** Set on a subtask only: the key of its parent run. */
  parentKey?: string;
  /** Set on a run a backlog task holds: the backlog and its milestone. */
  backlog?: RunBacklog;
  /** Set on a done subtask the parent has not merged yet: what the merge waits for, when it waits for something. */
  mergeWait?: string;
  /** Who started the run. Missing for a run the CLI started and for runs from before logins. */
  startedBy?: string;
  /** When a person took the run over from machine; absent for a run nobody took over. */
  ownerSince?: string;
  /** The tasks of a split plan after plan-improve, in plan order. Missing when the run does not split. */
  tasks?: TaskEntry[];
  /** Set on a run with subtask runs only: its own cost plus its subtasks', and the wall clock from its start to its end. */
  epic?: { usd: number; durationMs: number };
  /** `Split: 7 tasks · 5 merged · 2 running`, once the run is at implement or past it. Missing when the run does not split. */
  taskLine?: string;
  /** The tasks that are done with green CI and wait for their merge, in plan order. */
  mergeQueue?: { id: string; title: string }[];
  /** The `decisions:` the planner gave in the contract, one entry each. Missing when there are none. */
  decisions?: DecisionView[];
  /** The plan chat, always filled by the server. */
  conversation?: ConversationView;
  resume: 'ready' | 'need-answers' | 'running' | 'blocked' | 'done';
  state: RunState;
  stateReason: StateReason | null;
  /** Set on a done run whose merge requests were merged or closed. */
  merge?: MergeOutcome;
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
    attemptsPipeline: number;
    attemptsChecks: number;
    cpuPeak: number;
    memPeak: number;
  };
  phases: {
    phase: string;
    steps: {
      name: string;
      status: string;
      current: boolean;
      attempts: number;
      note?: string;
      /** Why the step was sent back, as `2 notes` or the check that failed. Set on a returned step only. */
      returnNote?: string;
      /** When the server restarted while this step's agent kept running, as an ISO time. Set only during that wait. */
      restartedAt?: string;
    }[];
  }[];
  returns: {
    counter: string;
    count: number;
    from: string;
    to: 'implement';
    why?: string;
    /** The time of the latest loop event of this counter, as an ISO time. */
    at?: string;
    /** The return in plain words, such as `Code review sent it back: requirements, quality`. */
    words?: string;
  }[];
  /** Relaunches after a rebase, oldest first. */
  relaunches?: RelaunchView[];
  /** The commands of the latest checks attempt. Missing when the run has none. */
  checkCommands?: CheckCommandView[];
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
  /** How hard the agent worked. Absent when it ran at its runtime's default. */
  effort?: Effort;
  /** Why the effort is what it is, such as `epic`. */
  effortNote?: string;
  mode: string | null;
  durationMs: number;
  /** What the run waited for between the end of the visit before and this visit's first event. */
  preparedMs?: number | null;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  cpuAvg: number;
  cpuPeak: number;
  memAvg: number;
  memPeak: number;
  killReason: string | null;
  /** What was decided for a visit cut by a server restart. Absent for any other visit. */
  interruption?: InterruptionNote;
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
    tools: 'none' | 'read' | 'plan' | 'write';
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
  /** The short name of the command; null for a row from before names. */
  name: string | null;
  status: 'waiting' | 'running' | 'passed' | 'failed' | 'skipped' | 'interrupted';
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
  /** The report of the run rendered now from its own state. Only the `code-review` step has it, and only for a run with the parts of the new report. */
  report?: string;
  descriptor: StepDescriptor;
  /** The last event `seq` of the run: it changes when there are new events to read. 0 means none. */
  eventsCursor: number;
}

export interface HistoryView {
  /** Relaunches after a rebase, oldest first. */
  relaunches?: RelaunchView[];
  launches: LaunchView[];
  documents: { kind: string; attempt: number; body: string; createdAt: string }[];
  files: { name: string; path: string; body: string | null }[];
  exchanges: { stepStatId: number; model: string; durationMs: number; request: string; response: string }[];
  /** `ciOnly`: a pipeline return where CI failed and the checks of the same content had passed. */
  loops: { counter: string; attempt: number; reason: string; ciOnly?: true; createdAt: string }[];
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

/** The projects a new run can use. */
export interface ProjectListView {
  projects: string[];
}

/** A repository of a code host that the server's token can push to. */
export interface RemoteRepository {
  /** Which host it lives on. The dashboard only passes it back. */
  host: string;
  /** The full namespace path of the owner, a subgroup of a nested namespace included. */
  owner: string;
  name: string;
  visibility: 'public' | 'private';
  defaultBranch: string;
}

export interface RemoteEntry extends RemoteRepository {
  /** True when the folder under the checkouts root is a clone of this repository. */
  cloned: boolean;
  /** Why the repository cannot be picked: its folder name belongs to another remote. */
  blocked?: string;
}

/** An account or an organization or group a repository can be created in. */
export interface RepositoryOwner {
  host: RemoteRepository['host'];
  login: string;
  kind: 'user' | 'organization' | 'group';
  /** The host's own id of the namespace, when creating needs it. */
  id?: number;
}

export interface RemoteListView {
  repositories: RemoteEntry[];
  owners: RepositoryOwner[];
  /** Why the list is empty because of the setup: no token. */
  reason: string | null;
  /** `SWARMLOOP_REPOS`. Empty when every name is allowed. */
  allowedNames: string[];
  /** True while a host with no snapshot yet is being read for the first time. */
  loading: boolean;
  /** The message of the last refresh that failed, named by host label; null when none. */
  error: string | null;
}

export interface CreateRepositoryBody {
  host: RemoteRepository['host'];
  owner: string;
  name: string;
  /** Private when absent. */
  public?: boolean;
}

export interface ProjectsView {
  projects: string[];
  applied: boolean;
}

/** `/auth/me`: who is signed in. */
export interface MeView {
  user: string | null;
  provider?: string;
  avatarUrl?: string | null;
  /** Release version of the server; `dev` when the image sets none. */
  version?: string;
  /** Source repository URL of the server image; null when it is not an http(s) address. */
  sourceUrl?: string | null;
  role?: Role;
  /** The first 7 characters of the commit the image was built from; absent when it is unknown. */
  revision?: string;
}
