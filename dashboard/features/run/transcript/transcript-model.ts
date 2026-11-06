import type { StepEvent } from '@contract/step-events';

export type Side = 'left' | 'right';
export type TranscriptFilter = 'all' | 'inputs' | 'actions' | 'problems';

type AgentStart = Extract<StepEvent, { kind: 'attempt.started' }>['agent'];
type CommandEnd = Extract<StepEvent, { kind: 'command.finished' }>;

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
}

export interface AttemptGroup {
  attemptId: string;
  /** The 1-based position of the attempt among the attempts of the step. */
  number: number;
  /** How the previous attempt ended. Null for the first. */
  reason: string | null;
  /** Set only when it differs from the previous attempt. */
  runtime: string | null;
  model: string | null;
  items: TranscriptItem[];
}

/** Where an issue first appeared, and whether a later pass resolved it. */
export type IssueLinks = Map<string, { eventId: string; resolved: boolean }>;

/** The issues of a run by id, from the events of every step. */
export function issueLinks(events: StepEvent[]): IssueLinks {
  const links: IssueLinks = new Map();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === 'issue.opened' && !links.has(event.issueId)) {
      links.set(event.issueId, { eventId: event.eventId, resolved: false });
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

function problemOf(event: StepEvent, end: CommandEnd | null): Problem | null {
  if (event.kind === 'command.started') {
    const action = `command: ${[event.executable, ...event.args].join(' ')}`;
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

function itemsOf(events: StepEvent[]): TranscriptItem[] {
  const ends = new Map<string, CommandEnd>();
  for (const event of events) {
    if (event.kind === 'command.finished') {
      ends.set(event.spanId, event);
    }
  }
  const shown = new Set<string>();
  /** An issue shows once in a window: a repeated event for the same issue adds no card. */
  const repeated = (event: StepEvent): boolean => {
    const keys =
      event.kind === 'issue.opened' || event.kind === 'issue.resolved'
        ? [`${event.kind}:${event.issueId}`]
        : event.kind === 'handoff.received'
          ? event.issueIds.map((id) => `${event.kind}:${id}`)
          : [];
    const all = keys.length > 0 && keys.every((key) => shown.has(key));
    keys.forEach((key) => shown.add(key));
    return all;
  };
  return events
    .filter((event) => event.kind !== 'attempt.started' && event.kind !== 'command.finished' && !repeated(event))
    .map((event) => {
      const end = event.kind === 'command.started' ? (ends.get(event.spanId) ?? null) : null;
      return { event, side: sideOf(event), end, problem: problemOf(event, end) };
    });
}

/** The attempts of a step in the order they started, each with its events in `seq` order. */
export function groupByAttempt(events: StepEvent[]): AttemptGroup[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const ids = [...new Set(ordered.map((event) => event.attemptId))];
  const groups: AttemptGroup[] = [];
  let runtime: string | null = null;
  let model: string | null = null;
  let reason: string | null = null;
  for (const attemptId of ids) {
    const own = ordered.filter((event) => event.attemptId === attemptId);
    const agent = own.reduce<AgentStart>(
      (found, event) => (event.kind === 'attempt.started' ? event.agent : found),
      null,
    );
    groups.push({
      attemptId,
      number: groups.length + 1,
      reason,
      runtime: agent && agent.runtime !== runtime ? agent.runtime : null,
      model: agent && agent.model !== model ? agent.model : null,
      items: itemsOf(own),
    });
    runtime = agent?.runtime ?? runtime;
    model = agent?.model ?? model;
    reason = own.reduce<string | null>(
      (found, event) =>
        event.kind === 'attempt.finished' || event.kind === 'attempt.interrupted'
          ? `${event.route}: ${event.summary}`
          : found,
      null,
    );
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
