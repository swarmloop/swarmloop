import { REASON, type StateReason } from '../contract/run-state';
import { isPersonResume } from './resume-sender';

/** The waits before try 1, 2 and 3 at one step, in minutes, from the run's last change. */
const WAITS_MIN = [15, 30, 60];
const TRIES_PER_STEP = WAITS_MIN.length;
const TRIES_IN_ALL = 6;
const OLD_MS = 24 * 3_600_000;

interface StallVisit {
  step: string;
  startedAt: string;
  finishedAt: string | null;
  attemptId: string | null;
}

interface StallCommand {
  type: string;
  payload: string;
  createdAt: string;
}

interface StallInput {
  now: number;
  key: string;
  currentStep: string;
  /** In stored order. */
  visits: StallVisit[];
  /** In stored order. */
  commands: StallCommand[];
}

export type StallDecision =
  | { kind: 'try'; key: string; tryNumber: number; line: string; payload: { stalledAt: string } }
  | { kind: 'person'; reason: StateReason };

interface Try {
  step: string;
  at: number;
}

/** The step a stall resume was sent for, or null for any other command. */
function stalledAt(command: StallCommand): string | null {
  if (command.type !== 'resume') return null;
  try {
    const value = (JSON.parse(command.payload) as { stalledAt?: unknown } | null)?.stalledAt;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function triesOf(commands: StallCommand[]): Try[] {
  const tries: Try[] = [];
  for (const command of commands) {
    const step = stalledAt(command);
    if (step !== null) tries.push({ step, at: Date.parse(command.createdAt) });
  }
  return tries;
}

/** The tries since the last person's Resume. */
function triesSincePerson(commands: StallCommand[]): Try[] {
  const lastPerson = commands.map((command) => isPersonResume(command)).lastIndexOf(true);
  return triesOf(commands.slice(lastPerson + 1));
}

/** The tries at the current step that no other step's visit came after. A new visit of the same step does not end them. */
function stepTries(tries: Try[], visits: StallVisit[], currentStep: string): number {
  const lastMove = Math.max(
    -Infinity,
    ...visits.filter((visit) => visit.step !== currentStep).map((visit) => Date.parse(visit.startedAt)),
  );
  let count = 0;
  for (let i = tries.length - 1; i >= 0; i -= 1) {
    if (tries[i].step !== currentStep || tries[i].at <= lastMove) break;
    count += 1;
  }
  return count;
}

/** The later of the end of the last visit and the newest command. */
function lastChange(visits: StallVisit[], commands: StallCommand[]): number {
  const last = visits[visits.length - 1];
  const ended = last ? Date.parse(last.finishedAt ?? last.startedAt) : -Infinity;
  const newest = commands.reduce((latest, command) => Math.max(latest, Date.parse(command.createdAt)), -Infinity);
  return Math.max(ended, newest);
}

function person(message: string): StallDecision {
  return { kind: 'person', reason: { code: REASON.stalled, message } };
}

/**
 * Whether a run that is idle with no reason is resumed now, given to a person, or left for later. The key names the
 * run, the attempt of its last visit and the ordinal of the try in its whole history, so it never repeats.
 */
export function stallDecision(input: StallInput): StallDecision | null {
  const { now, key, currentStep, visits, commands } = input;
  if (visits.length === 0) return null;
  const sincePerson = triesSincePerson(commands);
  const total = sincePerson.length;
  const atStep = stepTries(sincePerson, visits, currentStep);
  const exhausted = total >= TRIES_IN_ALL || atStep >= TRIES_PER_STEP;
  const waitMin = exhausted ? WAITS_MIN[0] : WAITS_MIN[atStep];
  const changed = lastChange(visits, commands);
  if (now - changed < waitMin * 60_000) return null;
  if (now - changed > OLD_MS) return person('Stalled for over 24 hours with no reason; Resume to try again');
  if (total >= TRIES_IN_ALL) return person('Stalled 7 times; the server stopped resuming it');
  if (atStep >= TRIES_PER_STEP) return person('Stalled 4 times with no reason; Resume to try again');
  const tryNumber = atStep + 1;
  const attempt = visits[visits.length - 1].attemptId ?? 'none';
  return {
    kind: 'try',
    key: `stall-${key}-${attempt}-${triesOf(commands).length + 1}`,
    tryNumber,
    line: `Stalled for ${waitMin} min with no reason; resumed (try ${tryNumber} of ${TRIES_PER_STEP})`,
    payload: { stalledAt: currentStep },
  };
}
