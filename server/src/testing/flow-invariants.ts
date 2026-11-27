import { ERROR_CODES } from '../contract/error-codes';
import {
  AUTO_RETRY_CODES,
  NEEDS_PERSON,
  TIMED_RETRY_CODES,
  type RunState,
  REASON,
  type StateReason,
} from '../contract/run-state';
import type { AgentExchangeEntity, RunEntity, StepStatEntity } from '../history/entities';
import { liveState, storedState, writeOpenItemState } from '../history/run-state';
import { QuestionHolds } from '../steps/shared/question-holds';
import { isDeepStrictEqual } from 'util';
import { DocumentRepository } from '../history/document.repository';
import { readParkedConflict } from '../pipeline/parked-conflict';
import { CommandRepository } from '../history/command.repository';
import { RunRepository } from '../history/run.repository';
import { VisitStartRepository } from '../history/visit-start.repository';
import type { VisitStartEntity } from '../history/visit-start.entity';
import { LIMIT_VISIT, VisitRepository } from '../history/visit.repository';
import type { TestApp } from './test-app';

/**
 * What must hold for every run after a reconciler tick. It throws one error that lists each run and rule that broke.
 * The codes that need a person and the codes that end by themselves come from `contract/run-state.ts`.
 * A run is read as the run page reads it: one with a command about to start it is `queued`, not idle.
 */
export async function assertInvariants(app: TestApp): Promise<void> {
  const runs = app.app.get(RunRepository);
  const visits = app.app.get(VisitRepository);
  const commands = app.app.get(CommandRepository);
  const starts = app.app.get(VisitStartRepository);
  const documents = app.app.get(DocumentRepository);
  const holds = app.app.get(QuestionHolds);
  const broken: string[] = [];
  for (const run of await runs.listRuns()) {
    const queued = (await commands.pending(run.id)).some((command) => command.type !== 'stop');
    const { state, reason } = liveState(run, { queued });
    const stats = await visits.listStats(run.id);
    const runStarts = await starts.forRun(run.id);
    broken.push(
      ...stateRules(run.key, state, reason),
      ...(await storedRules(holds, run)),
      ...(await conflictRules(documents, run, state, reason)),
      ...visitRules(run.key, state, reason, stats),
      ...startRules(run.key, runStarts),
      ...visitStartRules(run.key, stats, await visits.listExchanges(stats.map((stat) => stat.id)), runStarts),
    );
  }
  if (broken.length > 0) throw new Error(broken.join('\n'));
}

/** A run's stored state is what its row and its open items say: no pass after the write has to correct it. */
async function storedRules(holds: QuestionHolds, run: RunEntity): Promise<string[]> {
  const said = { ...run };
  writeOpenItemState(said, await holds.facts(run));
  return isDeepStrictEqual(storedState(said), storedState(run))
    ? []
    : [`${run.key} stores ${run.state ?? 'no state'}, but its row and open items say ${said.state ?? 'no state'}`];
}

/** A stop is on the needs-a-person list, and a wait or a stop says what happens next. */
function stateRules(key: string, state: RunState, reason: StateReason | null): string[] {
  const broken: string[] = [];
  const code = reason?.code ?? (state === 'failed' ? ERROR_CODES.STEP_FAILED : null);
  if ((state === 'failed' || state === 'blocked') && !(code && code in NEEDS_PERSON)) {
    broken.push(`${key} is ${state} with ${code ?? 'no code'}, which is not on the needs-a-person list`);
  }
  if ((state === 'waiting' || state === 'blocked') && !saysWhatNext(code, reason)) {
    broken.push(`${key} is ${state} and its reason does not say what happens next`);
  }
  return broken;
}

/** A run that holds a parked rebase conflict for implement is with implement or a planner: not blocked on it, not failed at implement. */
async function conflictRules(
  documents: DocumentRepository,
  run: RunEntity,
  state: RunState,
  reason: StateReason | null,
): Promise<string[]> {
  const stopped =
    (state === 'blocked' && reason?.code === ERROR_CODES.REBASE_CONFLICT) ||
    (state === 'failed' && run.currentStep === 'implement');
  if (!stopped || !(await readParkedConflict(documents, run))) return [];
  return [`${run.key} is ${state} on a rebase conflict that implement or a planner holds`];
}

/** A started run is not idle without a reason, and every visit that ended has its result. */
function visitRules(key: string, state: RunState, reason: StateReason | null, stats: StepStatEntity[]): string[] {
  const broken: string[] = [];
  if (state === 'idle' && !reason && stats.length > 0) broken.push(`${key} started and is idle with no reason`);
  for (const stat of stats) {
    if (!stat.status || !stat.finishedAt) broken.push(`${key} visit ${stat.id} of ${stat.step} has no result`);
  }
  return broken;
}

/** A start the machine or a planner made never repeats the input of an earlier start of the step, unless that visit did not finish, and never resumes a stop. */
function startRules(key: string, starts: VisitStartEntity[]): string[] {
  const broken: string[] = [];
  const digests = new Map<string, number>();
  for (const start of starts.filter((item) => item.startedBy !== 'person')) {
    if (start.startReason === REASON.stopped)
      broken.push(`${key} ${start.step} was started by the machine on a stopped run`);
    if (!start.inputDigest) continue;
    const seen = `${start.step}:${start.inputDigest}`;
    const first = digests.get(seen);
    if (first !== undefined && !start.rerunUnfinished) {
      broken.push(`${key} ${start.step} was started again on the same input as start ${first}`);
    }
    digests.set(seen, first ?? start.id);
  }
  return broken;
}

/** Every agent visit, but one that ended on a provider limit, has its start: by the attempt, or by the stat an outside start linked. */
function visitStartRules(
  key: string,
  stats: StepStatEntity[],
  exchanges: AgentExchangeEntity[],
  starts: VisitStartEntity[],
): string[] {
  const withExchange = new Set(exchanges.map((exchange) => exchange.stepStatId));
  return stats
    .filter((stat) => withExchange.has(stat.id))
    .filter((stat) => !(stat.status === LIMIT_VISIT.status && stat.killReason === LIMIT_VISIT.killReason))
    .filter((stat) => !starts.some((start) => start.attemptId === stat.attemptId || start.statId === stat.id))
    .map((stat) => `${key} visit ${stat.id} of ${stat.step} has no start`);
}

/** An automatic next try names its time; a stop names the action a person takes. */
function saysWhatNext(code: string | null, reason: StateReason | null): boolean {
  if (!code || !reason?.message) return false;
  if (TIMED_RETRY_CODES.includes(code)) return Boolean(reason.retryAt ?? reason.limit?.resumesAt);
  return AUTO_RETRY_CODES.includes(code) || code in NEEDS_PERSON;
}
