import { AUTO_RETRY_CODES, REASON } from '../contract/run-state';
import type { StepStatEntity } from '../history/entities';
import type { VisitStartEntity } from '../history/visit-start.entity';

/** What the same-input check reads of a step's past: its visits, how each was started, and why the run waits now. */
interface SameInputFacts {
  step: string;
  /** The digest of the input the step is about to start on. */
  digest: string | null;
  stats: Pick<StepStatEntity, 'id' | 'step' | 'attempt' | 'attemptId' | 'status' | 'killReason'>[];
  starts: Pick<VisitStartEntity, 'step' | 'attemptId' | 'inputDigest'>[];
  /** The code of the run's stored reason now, or null. */
  reasonCode: string | null;
}

type SameInputDecision =
  | { kind: 'new'; rerunUnfinished: boolean }
  /** The step already had this input: `visit` is the number the run page gives that visit, `statId` its stored row. */
  | { kind: 'same'; visit: number; statId: number };

const FINISHED = ['done', 'waiting', 'blocked'];

/** A visit that ended on its own: it was not killed, and it did not fail, crash or wait for an outage or a limit. */
function finished(stat: Pick<StepStatEntity, 'status' | 'killReason'>): boolean {
  return FINISHED.includes(stat.status) && !stat.killReason;
}

/**
 * Whether a start of the step is a rerun of a visit that did not finish: the newest attempt that started has no stored
 * visit (the process died), or its visit ended by a kill, a failure, an outage or a limit.
 */
function unfinishedTail(facts: SameInputFacts): boolean {
  const own = facts.stats.filter((stat) => stat.step === facts.step);
  const lastStart = [...facts.starts].reverse().find((start) => start.step === facts.step);
  if (lastStart && !facts.stats.some((stat) => stat.attemptId === lastStart.attemptId)) return true;
  const last = own.at(-1);
  return last !== undefined && !finished(last);
}

/**
 * Decides a start the machine or a planner asks for. The step's last finished visit is the one a new start is compared
 * with. A run that waits for a timed or automatic retry has no such visit: the retry runs again a visit that did not
 * finish, on the input it had. A start with no recorded digest to compare is a new input.
 */
export function sameInput(facts: SameInputFacts): SameInputDecision {
  const retrying =
    facts.reasonCode !== null && facts.reasonCode !== REASON.sameInput && AUTO_RETRY_CODES.includes(facts.reasonCode);
  if (retrying || unfinishedTail(facts)) return { kind: 'new', rerunUnfinished: true };
  const last = facts.stats.filter((stat) => stat.step === facts.step).at(-1);
  if (!last) return { kind: 'new', rerunUnfinished: false };
  const digest = facts.starts.find((start) => start.attemptId === last.attemptId)?.inputDigest;
  return digest && digest === facts.digest
    ? { kind: 'same', visit: last.attempt, statId: last.id }
    : { kind: 'new', rerunUnfinished: false };
}

/** The person the chain ends at, as the refusal line names them. */
const STARTER_WHO = 'the person who started the run';

/** What the run page shows while a planner is asked about a start that was not made. */
export function refusalLine(visit: number, who: string): string {
  return `Not started again: same input as visit ${visit}; asked ${who}`;
}

/**
 * The question a refused start puts up the planners' chain: the refusal line, then the step's last words whole. The
 * line names the person, who the question ends with, so the text is the same at every level.
 */
export function refusalQuestion(step: string, visit: number, lastWords: string): { from: string; text: string } {
  const head = `${refusalLine(visit, STARTER_WHO)}.`;
  return { from: step, text: lastWords.trim() ? `${head}\n\n${lastWords}` : head };
}
