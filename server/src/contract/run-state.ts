import type { ErrorCode } from './error-codes';
import { ERROR_CODES, IMAGE_ERROR_CODES, SUBTASK_WAIT_CODES } from './error-codes';
import {
  NEEDS_ANSWERS,
  REASON,
  WAITING_FOR_YOU,
  kindOf,
  waitingWord,
  type LimitState,
  type StateIcon,
  type StateReason,
  type StateTone,
  type WordShape,
} from './reason-words';

export { NEEDS_ANSWERS, REASON };
export type { LimitState, StateIcon, StateReason, StateTone };

/** The honest state of a run, next to the older `status`. */
export const RUN_STATES = [
  'idle',
  'queued',
  'running',
  'waiting',
  'stopping',
  'stopped',
  'recovering',
  'blocked',
  'failed',
  'done',
  'merged',
  'closed',
  'skipped',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** `pending` is what the plan writes; every reader sees it as `waiting`. `green`: the subtask is done, its merge request into the feature branch has green CI. */
export type SubtaskStatus = 'pending' | 'waiting' | 'running' | 'green' | 'merged' | 'blocked' | 'skipped';

/** What a person may ask of a run in its state. The server decides, the dashboard follows. */
export type RunAction = 'resume' | 'replay' | 'rebase' | 'stop' | 'answer';

/** Where one repository's merge request was merged, by whom and when. */
export interface MergedFact {
  sha: string | null;
  by: string | null;
  at: string;
  /** The page of the merge commit on the host, when it can be told from the request's url. */
  url: string | null;
}

/** How a done run's merge requests ended: all merged (by repository), or one closed without a merge. */
export type MergeOutcome =
  { merged: Record<string, MergedFact> } | { closed: { repo: string; by: string | null; at: string } };

/** What a step says when it waits for the planner's answer to its question. */
export const ASKS_PLANNER_WORDS = 'is waiting for the planner';

/** What every command on a skipped task's run is refused with. */
export const SKIPPED_NOTE = 'this task was skipped';

/** What a stopped step says. It also tells a stopped block from the others when only the error text is known. */
export const STOP_NOTE = 'Stopped by request. Commits, pushes and merge requests stay: Stop is not a rollback.';

/** True for the text a stopped step ends with. */
export function isStopNote(text: string): boolean {
  return text.includes(STOP_NOTE);
}

const RESUMABLE_BLOCKS: readonly string[] = [
  REASON.checkFailed,
  REASON.didNotFit,
  REASON.loopLimit,
  REASON.stopped,
  REASON.ciLogUnavailable,
  REASON.ciNotRun,
  REASON.ciTimeout,
  ERROR_CODES.SPEND_LIMIT,
  ERROR_CODES.PIPELINE_UNFIXED,
  ERROR_CODES.DISK_LOW,
  ERROR_CODES.TEST_FLAKY,
  ERROR_CODES.WORKSPACE_LOST,
  ERROR_CODES.BRANCH_IN_USE,
  ERROR_CODES.BRANCH_DIVERGED,
  ERROR_CODES.SUBTASK_BLOCKED,
  ERROR_CODES.PARENT_TREE_CONFLICT,
  ERROR_CODES.GIT_RULES,
  ...IMAGE_ERROR_CODES,
];

/** The reason codes that need a person, each with the action that clears it. */
export const NEEDS_PERSON: Readonly<Record<string, RunAction>> = {
  [NEEDS_ANSWERS]: 'answer',
  [ERROR_CODES.GIT_AUTH]: 'resume',
  [ERROR_CODES.IMAGE_MISSING]: 'resume',
  [ERROR_CODES.WORKSPACE_LOST]: 'resume',
  [ERROR_CODES.BRANCH_IN_USE]: 'resume',
  [ERROR_CODES.BRANCH_DIVERGED]: 'resume',
  [ERROR_CODES.REBASE_CONFLICT]: 'rebase',
  [REASON.stopped]: 'resume',
  [REASON.stalled]: 'resume',
  [REASON.loopLimit]: 'resume',
  [ERROR_CODES.SPEND_LIMIT]: 'resume',
  [REASON.checkFailed]: 'resume',
  [REASON.didNotFit]: 'resume',
  [REASON.ciNotRun]: 'resume',
  [REASON.ciLogUnavailable]: 'resume',
  [REASON.ciTimeout]: 'resume',
  [ERROR_CODES.PIPELINE_UNFIXED]: 'resume',
  [ERROR_CODES.SUBTASK_BLOCKED]: 'resume',
  [ERROR_CODES.PARENT_TREE_CONFLICT]: 'resume',
  [ERROR_CODES.DISK_LOW]: 'resume',
  [ERROR_CODES.TEST_FLAKY]: 'resume',
  [ERROR_CODES.GIT_RULES]: 'resume',
  [ERROR_CODES.INPUT_MISSING]: 'replay',
  [ERROR_CODES.RESOURCE_UNKNOWN]: 'replay',
  [REASON.blocked]: 'replay',
  [ERROR_CODES.STEP_FAILED]: 'resume',
};

/** The waiting reason codes that end by themselves: the run tries again without a person. */
export const AUTO_RETRY_CODES: readonly string[] = [
  ERROR_CODES.RUNTIME_LIMIT,
  ERROR_CODES.HOST_UNAVAILABLE,
  ERROR_CODES.CI_NOT_STARTED,
  ERROR_CODES.DOCKER_UNAVAILABLE,
  ERROR_CODES.SUBTASKS_RUNNING,
  ERROR_CODES.SUBTASK_WAITING,
  REASON.agentPlace,
  REASON.asksPlanner,
  REASON.sameInput,
];

/** The waiting codes whose next try is timed: a person may try now. */
export const TIMED_RETRY_CODES: readonly string[] = [
  ERROR_CODES.HOST_UNAVAILABLE,
  ERROR_CODES.CI_NOT_STARTED,
  ERROR_CODES.DOCKER_UNAVAILABLE,
  ERROR_CODES.RUNTIME_LIMIT,
];

/** The actions of a waiting run: a stored reason the server ends by itself keeps Stop, the others ask for an answer. */
function waitingActions(reasonCode: string | null): RunAction[] {
  if (
    reasonCode === ERROR_CODES.RUNTIME_LIMIT ||
    reasonCode === ERROR_CODES.GIT_AUTH ||
    reasonCode === REASON.stalled
  ) {
    return ['resume', 'replay', 'rebase'];
  }
  if (reasonCode && TIMED_RETRY_CODES.includes(reasonCode)) return ['stop', 'resume', 'replay', 'rebase'];
  return reasonCode &&
    (reasonCode === REASON.asksPlanner ||
      reasonCode === REASON.sameInput ||
      SUBTASK_WAIT_CODES.includes(reasonCode as ErrorCode))
    ? ['stop', 'resume', 'replay', 'rebase']
    : ['answer', 'replay', 'rebase'];
}

/** What a run holds besides its state and code that changes which actions it offers. */
interface ActionFacts {
  /** The run holds a rebase conflict parked for implement, so Resume has it resolved. */
  parkedConflict?: boolean;
}

function blockActions(reasonCode: string | null, facts: ActionFacts): RunAction[] {
  if (reasonCode === ERROR_CODES.REBASE_CONFLICT && facts.parkedConflict) return ['resume', 'replay'];
  return reasonCode && RESUMABLE_BLOCKS.includes(reasonCode) ? ['resume', 'replay'] : ['replay'];
}

/** The one place that says which actions a state allows. Availability follows what the dashboard offered before. */
export function actionsFor(state: RunState, reasonCode: string | null = null, facts: ActionFacts = {}): RunAction[] {
  switch (state) {
    case 'idle':
    case 'failed':
    case 'stopped':
      return ['resume', 'replay', 'rebase'];
    case 'waiting':
      return waitingActions(reasonCode);
    case 'running':
      return ['stop', 'replay'];
    case 'stopping':
      return ['stop'];
    case 'blocked':
      return blockActions(reasonCode, facts);
    case 'done':
      return ['replay', 'rebase'];
    case 'merged':
    case 'skipped':
      return [];
    case 'closed':
      return ['replay'];
    case 'queued':
    case 'recovering':
      return [];
  }
}

/** What a person reads of a run's state: the word, who acts next, the icon, and the longer text for the tooltip. */
export interface StateWord {
  word: string;
  tone: StateTone;
  icon: StateIcon;
  tip: string;
}

const WORKING: WordShape = { word: 'Working', tone: 'working', icon: 'working' };

/** The word of each state. A new state gets its entry here. */
export const STATE_WORDS: Readonly<Record<RunState, WordShape>> = {
  idle: WORKING,
  queued: WORKING,
  running: WORKING,
  recovering: WORKING,
  stopping: WORKING,
  waiting: WAITING_FOR_YOU,
  blocked: { word: 'Blocked', tone: 'error', icon: 'blocked' },
  failed: { word: 'Failed', tone: 'error', icon: 'failed' },
  stopped: { word: 'Stopped', tone: 'neutral', icon: 'stopped' },
  done: { word: 'Ready to merge', tone: 'done', icon: 'ready' },
  merged: { word: 'Merged', tone: 'done', icon: 'merged' },
  closed: { word: 'Closed', tone: 'neutral', icon: 'closed' },
  skipped: { word: 'Skipped', tone: 'neutral', icon: 'skipped' },
};

/** A run that a repository's own rule stopped: a person puts the rule into `.swarmloop.json`. */
const GIT_RULES_WORD: WordShape = {
  word: 'Waits for you: a git rule of the repository',
  tone: 'person',
  icon: 'person',
};

const QUEUED: WordShape = { word: 'Queued to merge into the epic', tone: 'working', icon: 'queued' };

/** How a task that has no run reads. Waiting for another task is the server's turn. */
const NOT_STARTED: Readonly<Record<SubtaskStatus, WordShape>> = {
  pending: { word: 'Waiting to start', tone: 'working', icon: 'pending' },
  waiting: { word: 'Waiting to start', tone: 'working', icon: 'pending' },
  blocked: STATE_WORDS.blocked,
  skipped: STATE_WORDS.skipped,
  merged: STATE_WORDS.merged,
  green: QUEUED,
  running: STATE_WORDS.running,
};

/** Who and when, from the facts of one or more repositories: the latest time wins, each login is listed once. */
function endedTip(verb: string, facts: { by: string | null; at: string }[], time: (iso: string) => string): string {
  const logins = [...new Set(facts.flatMap((fact) => fact.by ?? []))];
  const latest = facts.map((fact) => fact.at).sort()[facts.length - 1];
  const when = latest ? time(latest) : '';
  return logins.length > 0 ? `${verb} by ${logins.join(', ')}${when ? `, ${when}` : ''}` : `${verb} ${when}`.trim();
}

function endedWord(state: RunState, merge: MergeOutcome | undefined, time: (iso: string) => string): StateWord | null {
  if (merge && 'closed' in merge) {
    return { ...STATE_WORDS.closed, tip: endedTip('Closed', [merge.closed], time) };
  }
  if (merge) {
    return { ...STATE_WORDS.merged, tip: endedTip('Merged', Object.values(merge.merged), time) };
  }
  return state === 'merged' || state === 'closed' ? { ...STATE_WORDS[state], tip: '' } : null;
}

function shapeOf(state: RunState, reason: StateReason | null, time: (iso: string) => string): WordShape {
  if (state === 'blocked' && reason?.code === ERROR_CODES.GIT_RULES) {
    return GIT_RULES_WORD;
  }
  return state === 'waiting' || (state === 'running' && reason && kindOf(reason.code) === 'place')
    ? waitingWord(reason, time)
    : STATE_WORDS[state];
}

/** The one place that turns a state into a word. `time` formats an ISO time: `contract/` has no formatter of its own. */
export function stateWord(
  state: RunState,
  reason: StateReason | null,
  facts: { subtask?: boolean; merge?: MergeOutcome; mergeWait?: string },
  time: (iso: string) => string,
): StateWord {
  const ended =
    state === 'done' || state === 'merged' || state === 'closed' ? endedWord(state, facts.merge, time) : null;
  if (ended) {
    return ended;
  }
  if (state === 'done' && facts.subtask) {
    return { ...QUEUED, tip: facts.mergeWait ?? '' };
  }
  const shape = shapeOf(state, reason, time);
  const explains = shape.tone === 'error' || shape.tone === 'person' || state === 'stopped';
  return { ...shape, tip: explains ? (reason?.message ?? '') : '' };
}

/** Whether a run reads `Waiting for you`: it waits for a person, not for something that ends by itself. */
export function needsPerson(state: RunState, reason: StateReason | null | undefined): boolean {
  return stateWord(state, reason ?? null, {}, (iso) => iso).tone === 'person';
}

/** The word of a task row: its run's word, the one the run list shows, or the not-started word when it has no run. */
export function taskStateWord(
  task: { status: SubtaskStatus; run?: { state: RunState; stateReason?: StateReason | null } },
  time: (iso: string) => string,
): StateWord {
  if (task.run) {
    return stateWord(task.run.state, task.run.stateReason ?? null, { subtask: true }, time);
  }
  return { ...NOT_STARTED[task.status], tip: '' };
}
