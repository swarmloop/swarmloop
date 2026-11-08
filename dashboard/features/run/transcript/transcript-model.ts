import { withoutTimestamp } from '@contract/event-text';
import { isReadOnlyGit } from '@contract/git-reads';
import type { StepEvent } from '@contract/step-events';

export type Side = 'left' | 'right';
export type ActorKind = 'server' | 'agent' | 'person' | 'pipeline' | 'git';
export interface Actor {
  kind: ActorKind;
  name: string;
}
export type TranscriptFilter = 'all' | 'inputs' | 'actions' | 'problems';

type AgentStart = Extract<StepEvent, { kind: 'attempt.started' }>['agent'];
type CommandEnd = Extract<StepEvent, { kind: 'command.finished' }>;
type Launched = Extract<StepEvent, { kind: 'agent.launched' }>;
type AgentEnd = Extract<StepEvent, { kind: 'agent.finished' }>;
type SessionChange = Extract<StepEvent, { kind: 'session.changed' }>;
type Manifest = Extract<StepEvent, { kind: 'context.manifest' }>;
type ActivityEnd = Extract<StepEvent, { kind: 'activity.finished' }>;
type AttemptEnd = Extract<StepEvent, { kind: 'attempt.finished' | 'attempt.interrupted' }>;
export type AgentWork = Extract<StepEvent, { kind: 'agent.tool' | 'agent.message' }>;

/** One launch of an agent: what it started with, what it did, and how it ended. */
export interface AgentBubble {
  launched: Launched;
  finished: AgentEnd | null;
  session: SessionChange | null;
  context: Manifest | null;
  work: AgentWork[];
}

/** A named stretch of a step: its commands are folded into it, and the git reads are only counted. */
export interface ActivityNode {
  finished: ActivityEnd | null;
  commands: TranscriptItem[];
  reads: number;
}

/** Why an event is an error, and the action it belongs to. */
export interface Problem {
  cause: string;
  action: string;
}

/** One card of the feed. `event` is the event it shows; a command also carries the event that ended it. */
export interface TranscriptItem {
  event: StepEvent;
  side: Side;
  end: CommandEnd | null;
  problem: Problem | null;
  bubble?: AgentBubble;
  activity?: ActivityNode;
  /** A run of read-only git queries outside any activity, shown as one card. */
  reads?: number;
  /** How the attempt ended, in words. Set on the card of `attempt.finished`. */
  outcome?: string;
  /** The card before it in the attempt is from the same actor on the same side, so avatar and name show once. */
  grouped?: boolean;
}

export interface AttemptGroup {
  attemptId: string;
  /** The 1-based position of the attempt among the attempts of the step. */
  number: number;
  /** Why the attempt ran: first run, resumed, replay or a return. */
  why: string;
  /** The model of the agent, whether or not it changed. */
  modelName: string | null;
  /** How the attempt ended, in words. Null while it runs. */
  outcome: string | null;
  items: TranscriptItem[];
}

/** Where an issue first appeared, and whether a later pass resolved it. */
export type IssueLinks = Map<
  string,
  { eventId: string; resolved: boolean; title: string; source: string; line: string; returnedTo: string | null }
>;

/** The issues of a run by id, from the events of every step. */
export function issueLinks(events: StepEvent[]): IssueLinks {
  const links: IssueLinks = new Map();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === 'issue.opened' && !links.has(event.issueId)) {
      links.set(event.issueId, {
        eventId: event.eventId,
        resolved: false,
        title: event.title,
        source: event.source,
        line: event.line ?? '',
        returnedTo: event.returnedTo ?? null,
      });
    }
    const link = event.kind === 'issue.resolved' ? links.get(event.issueId) : undefined;
    if (link) {
      link.resolved = true;
    }
  }
  return links;
}

/** Inputs of the step go right; everything the step did, or handed on, goes left. */
export function sideOf(event: StepEvent): Side {
  return event.kind === 'input.received' || event.kind === 'handoff.received' ? 'right' : 'left';
}

const ACTOR_NAMES: Record<ActorKind, string> = {
  server: 'Server',
  agent: 'Agent',
  person: 'You',
  pipeline: 'Pipeline',
  git: 'Git',
};

/** Who a card speaks for: the server, the agent, a person, the pipeline or git. */
export function actorOf(item: TranscriptItem): Actor {
  const { event } = item;
  let kind: ActorKind;
  if (item.reads) {
    kind = 'git';
  } else {
    switch (event.kind) {
      case 'command.started':
        kind = event.executable === 'git' ? 'git' : event.actor;
        break;
      case 'agent.launched':
      case 'agent.finished':
      case 'agent.tool':
      case 'agent.message':
        kind = 'agent';
        break;
      case 'input.received':
        kind = event.inputKind.startsWith('instructions') ? 'person' : 'pipeline';
        break;
      case 'handoff.received':
      case 'handoff.sent':
      case 'issue.opened':
      case 'issue.resolved':
      case 'attempt.started':
      case 'attempt.finished':
      case 'attempt.interrupted':
        kind = 'pipeline';
        break;
      case 'activity.started':
      case 'activity.finished':
      case 'artifact.produced':
      case 'command.finished':
      case 'context.manifest':
      case 'http.call':
      case 'host.suspended':
      case 'session.changed':
        kind = 'server';
    }
  }
  return { kind, name: ACTOR_NAMES[kind] };
}

/** Marks a card `grouped` when the one before it has the same side and actor. Apply it to the cards of one attempt. */
export function groupByActor(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item, index) => {
    const before = items[index - 1];
    const grouped = before !== undefined && before.side === item.side && actorOf(before).kind === actorOf(item).kind;
    return { ...item, grouped };
  });
}

/** A command as a person reads it: `-C <path>` shows the repo name. The event keeps the full args. */
export function commandLine(event: Extract<StepEvent, { kind: 'command.started' }>): string {
  const args =
    event.args[0] === '-C' && event.args.length > 1 ? ['-C', event.repo, ...event.args.slice(2)] : event.args;
  return [event.executable, ...args].join(' ');
}

function problemOf(event: StepEvent, end: CommandEnd | null): Problem | null {
  if (event.kind === 'command.started') {
    const action = `command: ${commandLine(event)}`;
    if (end?.timedOut) {
      return { cause: 'timed out', action };
    }
    if (end?.cancelled) {
      return { cause: 'cancelled', action };
    }
    return end && end.exitCode !== null && end.exitCode !== 0 ? { cause: `exit code ${end.exitCode}`, action } : null;
  }
  if (event.kind === 'agent.finished') {
    return event.killReason ? { cause: `killed: ${event.killReason}`, action: `agent: ${event.model}` } : null;
  }
  if (event.kind === 'http.call') {
    const action = `${event.method} ${event.url}`;
    if (event.statusCode === null) {
      return { cause: 'no response', action };
    }
    return event.statusCode >= 400 ? { cause: `status ${event.statusCode}`, action } : null;
  }
  if (event.kind === 'issue.opened') {
    return { cause: event.title, action: `issue ${event.issueId}` };
  }
  return event.kind === 'attempt.interrupted' ? { cause: event.summary, action: 'attempt' } : null;
}

/** An issue shows once in a window: a repeated event for the same issue adds no card. */
function repeatedIssue(shown: Set<string>, event: StepEvent): boolean {
  const keys =
    event.kind === 'issue.opened' || event.kind === 'issue.resolved'
      ? [`${event.kind}:${event.issueId}`]
      : event.kind === 'handoff.received'
        ? event.issueIds.map((id) => `${event.kind}:${id}`)
        : [];
  const all = keys.length > 0 && keys.every((key) => shown.has(key));
  keys.forEach((key) => shown.add(key));
  return all;
}

/** Builds the cards of one attempt from its events: the folded kinds feed the card they belong to. */
class ItemBuilder {
  readonly items: TranscriptItem[] = [];
  private readonly ends = new Map<string, CommandEnd>();
  private readonly finishes = new Map<string, ActivityEnd>();
  private readonly activities = new Map<string, TranscriptItem>();
  private readonly shown = new Set<string>();
  private bubble: AgentBubble | null = null;
  private session: SessionChange | null = null;
  private context: Manifest | null = null;
  private reads: TranscriptItem | null = null;

  constructor(events: StepEvent[]) {
    for (const event of events) {
      if (event.kind === 'command.finished') {
        this.ends.set(event.spanId, event);
      } else if (event.kind === 'activity.finished') {
        this.finishes.set(event.spanId, event);
      }
    }
    events.forEach((event) => this.add(event));
  }

  private push(item: TranscriptItem): void {
    this.items.push(item);
    this.reads = null;
  }

  private add(event: StepEvent): void {
    switch (event.kind) {
      case 'session.changed':
        this.session = event;
        return;
      case 'context.manifest':
        this.context = event;
        return;
      case 'agent.launched':
        this.launch(event);
        return;
      case 'agent.tool':
      case 'agent.message':
        this.bubble?.work.push(event);
        return;
      case 'agent.finished':
        this.finishAgent(event);
        return;
      case 'activity.started':
        this.openActivity(event);
        return;
      case 'command.started':
        this.command(event);
        return;
      case 'attempt.started':
      case 'command.finished':
      case 'activity.finished':
        return;
      case 'input.received':
      case 'handoff.received':
      case 'handoff.sent':
      case 'issue.opened':
      case 'issue.resolved':
      case 'artifact.produced':
      case 'attempt.finished':
      case 'attempt.interrupted':
      case 'http.call':
      case 'host.suspended':
        if (!repeatedIssue(this.shown, event)) {
          this.push({ event, side: sideOf(event), end: null, problem: problemOf(event, null) });
        }
    }
  }

  private launch(event: Launched): void {
    this.bubble = { launched: event, finished: null, session: this.session, context: this.context, work: [] };
    this.session = null;
    this.context = null;
    this.push({ event, side: 'left', end: null, problem: null, bubble: this.bubble });
  }

  private finishAgent(event: AgentEnd): void {
    if (this.bubble) {
      this.bubble.finished = event;
      this.bubble = null;
    }
    if (event.killReason) {
      this.push({ event, side: 'left', end: null, problem: problemOf(event, null) });
    }
  }

  private openActivity(event: Extract<StepEvent, { kind: 'activity.started' }>): void {
    const finished = this.finishes.get(event.spanId) ?? null;
    const item: TranscriptItem = {
      event,
      side: 'left',
      end: null,
      problem: finished?.failed ? { cause: finished.result, action: event.title } : null,
      activity: { finished, commands: [], reads: 0 },
    };
    this.activities.set(event.spanId, item);
    this.push(item);
  }

  /** A command goes into its activity. A read-only query is only counted, unless it failed. */
  private command(event: Extract<StepEvent, { kind: 'command.started' }>): void {
    const end = this.ends.get(event.spanId) ?? null;
    const parent = event.parentSpanId ? this.activities.get(event.parentSpanId)?.activity : undefined;
    const failed = end !== null && (end.exitCode !== 0 || end.timedOut || end.cancelled);
    const read = isReadOnlyGit(event.executable, event.args) && !failed;
    if (parent) {
      if (read) {
        parent.reads += 1;
      } else {
        parent.commands.push({ event, side: 'left', end, problem: null });
      }
    } else if (read && this.reads) {
      this.reads.reads = (this.reads.reads ?? 0) + 1;
    } else if (read) {
      this.reads = { event, side: 'left', end, problem: null, reads: 1 };
      this.items.push(this.reads);
    } else {
      this.push({ event, side: 'left', end, problem: problemOf(event, end) });
    }
  }
}

function itemsOf(events: StepEvent[]): TranscriptItem[] {
  return new ItemBuilder(events).items;
}

/** The first line of a result, as a sentence about what the attempt came to. */
function outcomeWords(finish: AttemptEnd, target: string | null, issues: number): string {
  const line = withoutTimestamp(finish.summary).split('\n')[0]?.trim() ?? '';
  if (finish.kind === 'attempt.interrupted') {
    return `Stopped: ${line}`;
  }
  switch (finish.route) {
    case 'ok':
      return target ? `Done, next: ${target}` : 'Done';
    case 'waiting': {
      const questions = /(\d+) questions?/.exec(finish.summary)?.[1];
      return questions ? `Waiting for answers: ${questions} questions` : `Waiting: ${line}`;
    }
    case 'blocked':
      return `Blocked: ${line}`;
    case 'failed':
      return `Failed: ${line}`;
    default:
      return issues > 0 ? `Returned to ${finish.route}: ${issues} issues` : `Moved to ${finish.route}`;
  }
}

/** What the attempt did, besides how it ended: the lines its step added, such as the checks result. */
function outcomeFacts(finish: AttemptEnd): string[] {
  return finish.kind === 'attempt.finished' ? (finish.facts?.details ?? []) : [];
}

function isAttemptEnd(event: StepEvent): event is AttemptEnd {
  return event.kind === 'attempt.finished' || event.kind === 'attempt.interrupted';
}

/** How an attempt ended as one line, from its own events. */
function attemptOutcome(own: StepEvent[], finish: AttemptEnd): string {
  const sent = own.find((event) => event.kind === 'handoff.sent');
  const target = sent?.kind === 'handoff.sent' ? sent.targetStep : null;
  const issues = own.filter((event) => event.kind === 'issue.opened').length;
  return [outcomeWords(finish, target, issues), ...outcomeFacts(finish)].join(' · ');
}

function whyOf(own: StepEvent[], number: number): string {
  const received = own.find((event) => event.kind === 'handoff.received');
  if (received?.kind === 'handoff.received' && received.from) {
    return `return from ${received.from}`;
  }
  if (own.some((event) => event.kind === 'session.changed' && event.reason === 'replay')) {
    return 'replay';
  }
  if (own.some((event) => event.kind === 'agent.launched' && event.resumed)) {
    return 'resumed';
  }
  return number === 1 ? 'first run' : 'run again';
}

/** The attempts of a step in the order they started, each with its events in `seq` order. */
export function groupByAttempt(events: StepEvent[]): AttemptGroup[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const ids = [...new Set(ordered.map((event) => event.attemptId))];
  const groups: AttemptGroup[] = [];
  for (const attemptId of ids) {
    const own = ordered.filter((event) => event.attemptId === attemptId);
    const ended = own.filter(isAttemptEnd);
    const agent = own.reduce<AgentStart>(
      (found, event) => (event.kind === 'attempt.started' ? event.agent : found),
      null,
    );
    groups.push({
      attemptId,
      number: groups.length + 1,
      why: whyOf(own, groups.length + 1),
      modelName: agent?.model ?? null,
      outcome: ended.length > 0 ? attemptOutcome(own, ended[ended.length - 1]) : null,
      items: itemsOf(own).map((item) =>
        isAttemptEnd(item.event) ? { ...item, outcome: attemptOutcome(own, item.event) } : item,
      ),
    });
  }
  return groups;
}

/** A view of the same list: it drops cards and keeps the order of the rest. */
export function filterEvents(items: TranscriptItem[], filter: TranscriptFilter): TranscriptItem[] {
  switch (filter) {
    case 'inputs':
      return items.filter((item) => item.side === 'right');
    case 'actions':
      return items.filter((item) => item.side === 'left');
    case 'problems':
      return items.filter((item) => item.problem !== null);
    case 'all':
      return items;
  }
}

/** The `eventId` of the first problem of the step, or null when it had none. */
export function firstProblemId(events: StepEvent[]): string | null {
  return (
    groupByAttempt(events)
      .flatMap((group) => group.items)
      .find((item) => item.problem)?.event.eventId ?? null
  );
}
