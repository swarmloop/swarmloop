import { ERROR_CODES } from '../../contract/error-codes';
import { REASON, TIMED_RETRY_CODES } from '../../contract/run-state';
import type { StateReason } from '../../contract/reason-words';
import type { StepStatEntity } from '../../history/entities';
import type { VisitStartEntity } from '../../history/visit-start.entity';
import { KILL_REASONS } from '../../core/kill-reason';
import { visitKillReason } from './model-visit';

/**
 * The code the same-input check reads for a run's reason: a host wait that the chain's ask after a refusal left
 * (`refusedStart`) reads as the same-input wait, so the resumed start is refused again and the chain is asked again.
 */
export function sameInputCode(reason: StateReason | null): string | null {
  return reason?.refusedStart ? REASON.sameInput : (reason?.code ?? null);
}

/** What the same-input check reads of a step's past: its visits, how each was started, and why the run waits now. */
interface SameInputFacts {
  step: string;
  /** The digest of the input the step is about to start on. */
  digest: string | null;
  stats: (Pick<StepStatEntity, 'id' | 'step' | 'attempt' | 'attemptId' | 'status' | 'killReason'> & {
    /** The errors stored with the visit as its answer-errors document: its answer stayed invalid. */
    answerErrors?: readonly string[];
  })[];
  starts: Pick<VisitStartEntity, 'step' | 'attemptId' | 'inputDigest'>[];
  /** The code of the run's stored reason now, or null. */
  reasonCode: string | null;
}

type SameInputDecision =
  | { kind: 'new'; rerunUnfinished: boolean }
  /** The step already had this input: `visit` is the number the run page gives that visit, `statId` its stored row. */
  | { kind: 'same'; visit: number; statId: number };

const FINISHED = ['done', 'waiting', 'blocked'];

/** The waits on something outside swarmloop that the reconciler clears by itself: the retry runs the visit again. */
const OUTSIDE_WAIT_CODES: readonly string[] = [...TIMED_RETRY_CODES, ERROR_CODES.GIT_AUTH];

/**
 * A visit that ended on its own, so it counts as finished on its input: it finished (not killed, not failed, no outage
 * or limit wait), its answer stayed invalid after its follow-ups (it has stored answer errors), or the agent's own
 * limit killed it (calls, loop, tokens, spend, time or idle). Every other end runs again on its input: a process that
 * died (no stored visit), a model host outage, a usage limit, an outside wait, a person's Stop and any other failure.
 */
function endedOnItsOwn(stat: SameInputFacts['stats'][number]): boolean {
  if (FINISHED.includes(stat.status) && !stat.killReason) return true;
  if ((stat.answerErrors?.length ?? 0) > 0) return true;
  return KILL_REASONS.some((reason) => visitKillReason(reason) === stat.killReason);
}

/**
 * Whether a start of the step is a rerun of a visit that did not end on its own: the newest attempt that started has
 * no stored visit (the process died), or its visit ended by an outage, a limit wait, a Stop or another failure.
 */
function unfinishedTail(facts: SameInputFacts): boolean {
  const own = facts.stats.filter((stat) => stat.step === facts.step);
  const lastStart = [...facts.starts].reverse().find((start) => start.step === facts.step);
  if (lastStart && !facts.stats.some((stat) => stat.attemptId === lastStart.attemptId)) return true;
  const last = own.at(-1);
  return last !== undefined && !endedOnItsOwn(last);
}

/**
 * Decides a start the machine or a planner asks for. The step's last finished visit is the one a new start is
 * compared with.
 * - A run that waits for an outage, a limit or its person's reconnect has no such visit: the retry runs again a visit that did not finish, on
 *   the input it had.
 * - A run that waits for its planner's answer starts the step once the planner has taken its turn, which comes after
 *   this check, so that start is on the answer.
 * - Any other wait (a need, running subtasks, a planner asked) leaves the finished visit as the one to compare with;
 *   only an unfinished tail runs again.
 * A start with no recorded digest to compare is a new input.
 */
export function sameInput(facts: SameInputFacts): SameInputDecision {
  const retrying =
    facts.reasonCode !== null &&
    (facts.reasonCode === REASON.asksPlanner || OUTSIDE_WAIT_CODES.includes(facts.reasonCode));
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
 * The question a refused start puts up the planners' chain: the refusal line, then the step's last words whole, then the errors its answer was refused for. The
 * line names the person, who the question ends with, so the text is the same at every level.
 */
export function refusalQuestion(
  step: string,
  visit: number,
  lastWords: string,
  answerErrors: readonly string[] = [],
): { from: string; text: string } {
  const head = `${refusalLine(visit, STARTER_WHO)}.`;
  const words = lastWords.trim() ? `${head}\n\n${lastWords}` : head;
  const refused = answerErrors.map((error) => `- ${error}`).join('\n');
  return { from: step, text: refused ? `${words}\n\nThe answer was refused for:\n${refused}` : words };
}
