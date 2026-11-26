import { createHash } from 'crypto';
import { allTasks, backlogText, hasBriefFile, milestoneHead, requirementText, taskText } from './turn-lines';
import type { DecisionState, TaskState, TurnState } from './turn-state';

/** What the chat has seen of the backlog: one line per backlog, milestone, requirement and task, the hash of each brief, and the newest decision. */
interface SeenState {
  lines: Record<string, string>;
  briefs: Record<string, string>;
  decision: number;
}

/** What changed in the database since the chat saw a state. */
export interface StateChanges {
  /** The lines that are new or changed, with their current text. */
  changed: { key: string; text: string }[];
  /** The keys that are no longer in the backlog. */
  gone: string[];
  /** The tasks whose brief changed since the chat saw it. */
  briefs: string[];
  /** The decisions made after the last one the chat saw, oldest first. */
  decisions: DecisionState[];
}

function briefHash(task: TaskState): string {
  return createHash('sha1').update(task.description).digest('hex').slice(0, 12);
}

/** The state lines of a turn, keyed `backlog`, `milestone:<n>`, `requirement:<ref>` and `task:<slug>`, written as the brief writes them. */
export function stateLinesOf(state: TurnState): Record<string, string> {
  const lines: Record<string, string> = { backlog: backlogText(state.backlog) };
  for (const milestone of [...(state.active ? [state.active] : []), ...state.planned]) {
    lines[`milestone:${milestone.number}`] = milestoneHead(milestone);
    for (const requirement of milestone.requirements)
      lines[`requirement:${requirement.ref}`] = requirementText(requirement);
  }
  for (const task of allTasks(state)) lines[`task:${task.slug}`] = taskText(task);
  return lines;
}

function briefsOf(state: TurnState): Record<string, string> {
  return Object.fromEntries(
    allTasks(state)
      .filter(hasBriefFile)
      .map((task) => [task.slug, briefHash(task)]),
  );
}

/** The seen state to store once the chat has answered this turn. */
export function encodeSeen(state: TurnState): string {
  const seen: SeenState = {
    lines: stateLinesOf(state),
    briefs: briefsOf(state),
    decision: state.allDecisions[0]?.id ?? 0,
  };
  return JSON.stringify(seen);
}

function isTextMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

/** A stored seen state; an unreadable one, or none, counts as none. */
export function decodeSeen(text: string | null): SeenState | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { lines, briefs, decision } = value as Record<string, unknown>;
    if (!isTextMap(lines) || !isTextMap(briefs) || typeof decision !== 'number') return null;
    return { lines, briefs, decision };
  } catch {
    return null;
  }
}

/** What is new or changed in the state since the chat saw `seen`. */
export function diffSeen(seen: SeenState, state: TurnState): StateChanges {
  const lines = stateLinesOf(state);
  const briefs = briefsOf(state);
  return {
    changed: Object.entries(lines)
      .filter(([key, text]) => seen.lines[key] !== text)
      .map(([key, text]) => ({ key, text })),
    gone: Object.keys(seen.lines).filter((key) => !(key in lines)),
    briefs: Object.entries(briefs)
      .filter(([slug, hash]) => slug in seen.briefs && seen.briefs[slug] !== hash)
      .map(([slug]) => slug),
    decisions: state.allDecisions.filter((item) => item.id > seen.decision).reverse(),
  };
}
